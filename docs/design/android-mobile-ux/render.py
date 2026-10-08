#!/usr/bin/env python3
"""Render and exercise the fictional proposal, never an Android/SSH test."""
import argparse
import functools
import hashlib
import http.server
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from build import ROOT, STATES, build

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

def run(chromium):
    build()
    evidence = ROOT/"evidence"
    evidence.mkdir(exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1",0),handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    report = {"kind":"fictional-design-browser-checks-not-Android-runtime",
              "baseSourceSha":"ded417ba852295f3ad76bcca4e6e557d1288ca12",
              "externalRequests":[],"consoleErrors":[],"checks":[]}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chromium,args=["--no-sandbox"])
            context = browser.new_context(viewport={"width":1120,"height":1000},device_scale_factor=2)
            page = context.new_page()
            page.on("pageerror",lambda e:report["consoleErrors"].append(str(e)))
            page.on("request",lambda r:report["externalRequests"].append(r.url) if not r.url.startswith(base) else None)
            page.goto(base+"/prototype.html")
            page.evaluate("document.fonts.ready")
            for key in STATES:
                page.evaluate("name=>window.designShow(name)",key)
                result = page.evaluate("""()=>{
                  const m=document.querySelector('.mobile'),r=m.getBoundingClientRect();
                  const small=[...m.querySelectorAll('button')].filter(b=>{const q=b.getBoundingClientRect();return q.width<47.9||q.height<47.9}).map(b=>({text:b.textContent,width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}));
                  const term=m.querySelector('.terminal');
                  return {state:m.dataset.state,width:r.width,height:r.height,smallTargets:small,terminalHeight:term?term.getBoundingClientRect().height:null};
                }""")
                assert not result["smallTargets"], result
                report["checks"].append(result)
            flows = [
                ("first-login","hosts",["connect","trust","tmux","terminal"]),
                ("takeover","tmux",["occupied","takeover","terminal"]),
                ("duplicate","tmux",["new-session","collision","tmux"]),
                ("paste-cancel","terminal",["more","paste","terminal"]),
                ("delete","credentials",["delete-password","deleted","hosts"]),
                ("update-failure","credentials",["update-password","update-failed","credentials"]),
                ("notification-stop","terminal",["more","background","permission","notification","stopped"]),
                ("permission-denial","background",["permission","permission-denied","terminal"]),
                ("missing-recovery","offline",["offline-details","missing","tmux"]),
            ]
            for name,start,targets in flows:
                page.evaluate("name=>window.designShow(name)",start)
                for target in targets:
                    page.locator(f".mobile [data-screen='{target}']").first.click()
                    assert page.get_attribute("body","data-current")==target
                report["checks"].append({"flow":name,"transitions":len(targets),"passed":True})
            for width,height,key in [(360,800,"terminal-ime"),(420,900,"terminal"),(840,900,"fold-ime"),(800,360,"landscape")]:
                page.set_viewport_size({"width":width,"height":height})
                page.goto(base+f"/prototype.html?capture&screen={key}")
                page.evaluate("document.fonts.ready")
                page.locator(".mobile").screenshot(path=str(evidence/f"{key}.png"))
                report["checks"].append({"viewport":[width,height],"screen":key,"passed":True})
            page.set_viewport_size({"width":1120,"height":1000})
            page.goto(base+"/review.html")
            page.evaluate("document.fonts.ready")
            for key,name in [("focus","Tabby-Android-Terminal-Design.png"),("fold","Tabby-Android-Foldable-Design.png"),("first","Tabby-Android-First-Connection-Design.png")]:
                page.locator("#"+key).screenshot(path=str(evidence/name))
            page.pdf(path=str(evidence/"Tabby-Android-Design-Review.pdf"),print_background=True,prefer_css_page_size=True)
            assert not report["consoleErrors"], report["consoleErrors"]
            assert not report["externalRequests"], report["externalRequests"]
            assert page.evaluate("localStorage.length+sessionStorage.length")==0
            report["storageEntries"]=0
            report["status"]="passed"
            report["artifacts"]={x.name:{"bytes":x.stat().st_size,"sha256":hashlib.sha256(x.read_bytes()).hexdigest()} for x in evidence.iterdir() if x.suffix in (".png",".pdf")}
            (evidence/"design-render-report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
            browser.close()
        print(json.dumps({"states":len(STATES),"flows":len(flows),"viewports":4,"status":report["status"],"evidence":str(evidence)}))
    finally:
        server.shutdown()

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--chromium",default="/usr/bin/chromium")
    run(parser.parse_args().chromium)
