"""Exercise the fictional interaction proposal. Never Android or remote-input proof."""
def check_navigation(page, report):
    checks=[]
    def show(name):
        page.evaluate("n=>window.designShow(n)",name)
    def index():
        return page.evaluate("window.designNavigation.index")
    def drag(selector,dx,dy=0):
        box=page.locator(selector).bounding_box()
        x=box["x"]+box["width"]/2;y=box["y"]+box["height"]/2
        page.mouse.move(x,y);page.mouse.down()
        page.mouse.move(x+dx,y+dy,steps=8);page.mouse.up()
    def record(name):
        checks.append({"proposalInteraction":name,"passed":True})
    show("navigation-phone")
    assert index()==1
    drag(".nav-title",-20)
    assert index()==1 and page.get_attribute("body","data-current")=="navigation-phone"
    record("title-short-drag-cancels-click-and-switch")
    drag(".nav-title",-80)
    assert index()==2
    drag(".nav-title",-80)
    assert index()==2
    record("title-next-and-last-boundary-no-wrap")
    drag(".nav-title",80);drag(".nav-title",80)
    assert index()==0
    drag(".nav-title",80)
    assert index()==0
    record("title-first-boundary-no-wrap")
    show("navigation-phone")
    drag(".nav-title",-80,60)
    assert index()==1
    record("vertical-dominant-drag-cancels")
    box=page.locator(".nav-title").bounding_box();x=box["x"]+box["width"]/2;y=box["y"]+24
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x-80,y,steps=6)
    page.mouse.move(x-10,y,steps=6);page.mouse.up()
    assert index()==1
    record("title-reversed-short-release-cancels")
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x-80,y,steps=6)
    page.evaluate("document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))")
    page.mouse.up()
    assert index()==1
    record("pointercancel-does-not-switch")
    drag(".nav-terminal",-80)
    assert index()==1
    record("terminal-content-drag-does-not-switch")
    show("navigation-ime")
    page.evaluate("window.designKeyLog.length=0")
    drag(".key-viewport",-160)
    assert page.locator(".key-viewport").evaluate("e=>e.scrollLeft")>0
    assert page.evaluate("window.designKeyLog.length")==0
    record("key-strip-drag-scrolls-with-zero-simulated-keys")
    page.locator(".key-viewport").evaluate("e=>e.scrollLeft=0")
    page.locator('[data-nav-key="Ctrl"]').click()
    assert page.locator(".modifier").inner_text().startswith("Ctrl")
    assert page.locator('[data-nav-key="Ctrl"]').get_attribute("aria-pressed")=="true"
    page.locator('[data-nav-key="Esc"]').click()
    assert page.evaluate("window.designKeyLog.length")==1
    assert page.evaluate("window.designKeyLog[0].modifiers.Ctrl")=="once"
    assert page.evaluate("Object.keys(window.designNavigation.modifier).length")==0
    record("explicit-key-click-consumes-one-shot-modifier-once")
    page.locator(".all-keys").click()
    page.locator('[data-lock-modifier="Ctrl"]').click()
    assert page.locator(".modifier").inner_text().startswith("Ctrl 锁定")
    drag(".key-viewport",-160)
    assert page.locator(".modifier").is_visible()
    assert page.evaluate("window.designNavigation.modifier.Ctrl")=="lock"
    record("locked-modifier-remains-visible-while-key-strip-scrolls")
    drag(".nav-title",-80)
    assert index()==2
    assert page.evaluate("Object.keys(window.designNavigation.modifier).length")==0
    assert not page.locator(".ime").is_visible()
    assert page.locator('[aria-label="显示键盘"]').is_disabled()
    record("offline-selection-clears-modifiers-and-input-focus-intent")
    page.locator('[data-screen="more"]').click()
    page.evaluate("window.designShow('navigation-all-keys')")
    assert page.locator('[data-nav-key="Esc"]').is_disabled()
    assert page.locator('[data-lock-modifier="Ctrl"]').is_disabled()
    record("offline-key-and-lock-controls-disabled")
    show("navigation-ime")
    page.locator(".nav-terminal").evaluate("e=>e.scrollTop=220")
    before=page.locator(".nav-terminal").evaluate("e=>e.scrollTop")
    assert before>0
    page.locator(".home").click()
    assert page.get_attribute("body","data-current")=="navigation-home"
    page.locator('[data-nav-open="1"]').click()
    assert index()==1
    after=page.locator(".nav-terminal").evaluate("e=>e.scrollTop")
    assert abs(before-after)<1
    record("home-and-return-preserve-terminal-viewport")
    show("navigation-wide")
    drag(".nav-tabs",-80)
    assert index()==1
    assert page.locator(".nav-tabs").evaluate("e=>e.scrollLeft")>0
    record("wide-tab-drag-scrolls-without-selecting")
    page.locator('[data-nav-session="0"]').click()
    assert index()==0
    assert page.locator('[data-nav-session="0"]').get_attribute("aria-selected")=="true"
    record("wide-tab-explicit-click-selects-readonly")
    show("terminal-ime")
    assert page.locator(".ime").get_attribute("aria-label").startswith("系统输入法区域")
    assert page.locator(".quickkeys").get_attribute("aria-label")=="Tabby终端快捷键栏"
    assert page.locator(".home").get_attribute("aria-label")=="回到连接与会话"
    for width,height in [(360,800),(420,900),(840,900),(800,360)]:
        page.set_viewport_size({"width":width,"height":height})
        show("navigation-wide" if width>=600 and height>500 else "navigation-phone")
        assert page.locator(".status").bounding_box()["height"]==48
        assert page.locator(".nav-root").bounding_box()["height"]>0
    record("ownership-labels-accessible-buttons-and-single-48px-header")
    report["checks"].extend(checks)
    report["proposalGestureChecks"]=len(checks)
