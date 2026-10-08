"""Packaged aapt2 component policy. Never authorize SSH boot/network receivers."""
import re

APP = 'org.tabby.android.prototype'
PROFILE_ACTIONS = {'androidx.profileinstaller.action.' + action for action in
                   ['INSTALL_PROFILE', 'SKIP_FILE', 'SAVE_PROFILE', 'BENCHMARK_OPERATION']}


class ManifestPolicyError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ManifestPolicyError(code)


def components(manifest, kind):
    lines = manifest.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r'^( +)E: ' + re.escape(kind) + r'(?:\s|$)', line)
        if not match:
            continue
        indent = len(match[1])
        block = []
        for child in lines[index + 1:]:
            element = re.match(r'^( *)E:', child)
            if element and len(element[1]) <= indent:
                break
            block.append(child)
        yield indent, block


def attribute(component, name):
    indent, lines = component
    # SDK36 aapt2 prints the namespace URI, while older output uses its alias.
    namespace = r'(?:android|http://schemas\.android\.com/apk/res/android):'
    pattern = r'^ {' + str(indent + 2) + r'}A: ' + namespace + re.escape(name) + r'\([^)]*\)=(.*)$'
    values = [match[1] for line in lines if (match := re.match(pattern, line))]
    require(len(values) == 1, 'MISSING_OR_DUPLICATE_COMPONENT_ATTRIBUTE')
    value = values[0]
    return re.match(r'^"([^"\n]*)"', value)[1] if value.startswith('"') else value


def inspect_connection_components(manifest):
    services = list(components(manifest, 'service'))
    require(len(services) == 1, 'EXACTLY_ONE_CONNECTION_SERVICE_REQUIRED')
    service = services[0]
    require(attribute(service, 'name') in {APP + '.ConnectionService', '.ConnectionService'}, 'UNEXPECTED_SERVICE')
    require(attribute(service, 'exported') == 'false', 'EXPORTED_CONNECTION_SERVICE')
    require(attribute(service, 'foregroundServiceType') == '0x40000000', 'WRONG_FOREGROUND_SERVICE_TYPE')
    properties = list(components('\n'.join(service[1]), 'property'))
    require(any(attribute(prop, 'name') == 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE'
                and 'User initiated interactive SSH' in attribute(prop, 'value') for prop in properties), 'MISSING_SSH_SERVICE_PURPOSE')
    # AndroidX's existing profile receiver is DUMP protected and only handles
    # explicit ART tooling requests. It does not start this connection service.
    # https://github.com/androidx/androidx/blob/androidx-main/profileinstaller/profileinstaller/src/main/AndroidManifest.xml
    receivers = list(components(manifest, 'receiver'))
    require(len(receivers) <= 1, 'UNEXPECTED_RECEIVERS')
    for receiver in receivers:
        require(attribute(receiver, 'name') == 'androidx.profileinstaller.ProfileInstallReceiver', 'UNEXPECTED_RECEIVER')
        require(attribute(receiver, 'permission') == 'android.permission.DUMP', 'UNPROTECTED_PROFILE_RECEIVER')
        actions = list(components('\n'.join(receiver[1]), 'action'))
        require({attribute(action, 'name') for action in actions} == PROFILE_ACTIONS and len(actions) == 4, 'UNEXPECTED_PROFILE_ACTIONS')
    require('android.intent.action.BOOT_COMPLETED' not in manifest and 'android.intent.action.LOCKED_BOOT_COMPLETED' not in manifest, 'AUTOMATIC_BOOT_NOT_ALLOWED')
    return {'connectionServiceExported': False, 'foregroundServiceType': 'specialUse', 'automaticBoot': False,
            'existingDumpProtectedProfileReceiver': bool(receivers)}
