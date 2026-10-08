// Read-only selection of controls on this app's notification or test clipboard.
export function systemUIActionPoint (xml, action) {
    if (typeof xml !== 'string' || xml.length > 2 * 1024 * 1024) return undefined
    const stack = []; const nodes = []
    for (const token of xml.match(/<node\b[^>]*>|<\/node>/g) || []) {
        if (token === '</node>') { if (!stack.length) return undefined; stack.pop(); continue }
        const attrs = Object.fromEntries([...token.matchAll(/([\w-]+)="([^"<>]*)"/g)].map(match => [match[1], match[2]]))
        const node = { attrs, parent: stack.at(-1), children: [] }
        node.parent?.children.push(node); nodes.push(node)
        if (!token.endsWith('/>')) stack.push(node)
    }
    if (stack.length) return undefined
    const below = node => [node, ...node.children.flatMap(below)]
    let controls
    if (action === 'clipboardDismiss') {
        const roots = nodes.filter(node => node.attrs['resource-id'] === 'com.android.systemui:id/clipboard_ui')
        if (roots.length !== 1) return undefined
        controls = below(roots[0]).filter(node => node.attrs['resource-id'] === 'com.android.systemui:id/dismiss_button')
    } else {
        const titles = nodes.filter(node => node.attrs.text === 'Tabby · 后台连接')
        if (titles.length !== 1) return undefined
        let card = titles[0].parent
        while (card && !/\/status_bar_latest_event_content$/.test(card.attrs['resource-id'] || '')) card = card.parent
        if (!card) return undefined
        const descendants = below(card)
        controls = action === 'notificationStop' ? descendants.filter(node => node.attrs.text === '停止全部')
            : action === 'notificationExpand' ? descendants.filter(node => /\/expand_button(?:_touch_container)?$/.test(node.attrs['resource-id'] || '')) : []
        // Prefer the dedicated touch container over its child image.
        if (action === 'notificationExpand' && controls.some(node => /_touch_container$/.test(node.attrs['resource-id']))) {
            controls = controls.filter(node => /_touch_container$/.test(node.attrs['resource-id']))
        }
    }
    if (controls.length !== 1) return undefined
    const item = controls[0].attrs
    if (!['com.android.systemui', 'org.tabby.android.prototype', 'android'].includes(item.package) || item.enabled === 'false') return undefined
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(item.bounds || '')
    if (!bounds) return undefined
    const [left, top, right, bottom] = bounds.slice(1).map(Number)
    if (right <= left || bottom <= top || right > 100000 || bottom > 100000) return undefined
    return { x: (left + right) / 2, y: (top + bottom) / 2 }
}
