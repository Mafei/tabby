import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
    appId: 'org.tabby.android.prototype',
    appName: 'Tabby Android Prototype',
    webDir: 'www',
    loggingBehavior: 'none',
    server: {
        androidScheme: 'https',
        hostname: 'localhost',
        allowNavigation: [],
    },
    android: {
        allowMixedContent: false,
        webContentsDebuggingEnabled: false,
        backgroundColor: '#161b22',
    },
}

export default config
