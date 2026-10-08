#!/usr/bin/env python3
"""Check design budgets, color contrast, destinations and scope using stdlib."""
import json
import math
import re
import subprocess
import hashlib
from urllib.parse import urlparse
from build import ROOT, STATES

def luminance(value):
    parts=[int(value[i:i+2],16)/255 for i in (1,3,5)]
    linear=[v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4 for v in parts]
    return sum(v*w for v,w in zip(linear,(0.2126,0.7152,0.0722)))

def contrast(a,b):
    x,y=sorted((luminance(a),luminance(b)))
    return (y+.05)/(x+.05)

def validate():
    budgets=json.loads((ROOT/"budgets.json").read_text())
    expected={
        "phone-off":(752,35,35),"phone-on":(404,35,18),
        "phone-minimal":(452,35,20),"phone-safe-input":(356,35,16),
        "unfold-off":(852,85,40),"unfold-on":(484,85,22),
        "landscape-on":(132,81,5),
    }
    results=[]
    for row in budgets["rows"]:
        h=row["height"]-row["ime"]-budgets["statusDp"]-row["keys"]-row["input"]
        w=row["width"]-row["panel"]
        cols=math.floor((w-2*budgets["paddingDp"])/budgets["cellWidthDp"])
        rows=math.floor((h-2*budgets["paddingDp"])/budgets["cellHeightDp"])
        assert (h,cols,rows)==expected[row["id"]],row
        assert h>0 and cols>0 and rows>0
        results.append({"budget":row["id"],"terminalDp":h,"cols":cols,"rows":rows})
    colors=budgets["colors"]
    for background in ("background","surface"):
        for foreground in ("text","muted","accent","warning","danger"):
            value=contrast(colors[foreground],colors[background])
            assert value>=4.5,(foreground,background,value)
            results.append({"contrast":f"{foreground}/{background}","ratio":round(value,2)})
    sources=json.loads((ROOT/"sources.json").read_text())
    assert sources["baseline"]=="ded417ba852295f3ad76bcca4e6e557d1288ca12"
    assert len(sources["sources"])>=25
    assert len({s["id"] for s in sources["sources"]})==len(sources["sources"])
    for source in sources["sources"]:
        assert urlparse(source["url"]).scheme=="https",source
        assert source["scope"],source
    for key,state in STATES.items():
        for target in re.findall(r'data-screen="([^"]+)"',state["html"]):
            assert target in STATES,(key,target)
    for file in ("prototype.html","review.html","states.json"):
        assert (ROOT/file).is_file(),file
    prototype=(ROOT/"prototype.html").read_text()
    assert not re.search(r"<(?:script|link|img)[^>]+(?:src|href)=",prototype)
    assert not re.search(r"\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b",prototype)
    assert "不连接 SSH" in prototype and "设计提案" in prototype
    evidence=json.loads((ROOT/"preview/design-render-report.json").read_text())
    assert evidence["status"]=="passed"
    for name in ("prototype.html","review.html","states.json"):
        assert evidence["renderedDesign"][name]==hashlib.sha256((ROOT/name).read_bytes()).hexdigest(),name
    assert evidence["proposalGestureChecks"]>=16
    assert evidence["exportedScreenBodyTextMinimumContrast"]>=4.5
    changed=subprocess.check_output(["git","diff","--name-only",sources["baseline"]],cwd=ROOT,text=True).splitlines()
    for file in changed:
        assert file.startswith("docs/design/android-mobile-ux/") or file==".github/workflows/android-design-review.yml",file
    print(json.dumps({"status":"passed","kind":"design-checks-only","states":len(STATES),
        "sources":len(sources["sources"]),"budgets":results[:7],
        "minimumContrast":min(x["ratio"] for x in results if "ratio" in x),
        "trackedChangeScope":changed},ensure_ascii=False,indent=2))

if __name__=="__main__":
    validate()
