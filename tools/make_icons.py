"""Render the vector Tarjoman mark to the four Manifest V3 icon sizes.

The authored identity is icons/mark.svg; Chromium rasterizes the very same
geometry used by the UI. No font, image package or network is required.
"""
import base64,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'dev'))
import run_harness as H

def main():
    svg=(ROOT/'icons/mark.svg').read_text('utf8')
    with H.serve() as (port,ws,proc):
        target=ws.call('Target.createTarget',{'url':'about:blank'})['targetId']
        session=ws.call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
        ws.call('Page.enable',session=session)
        ws.call('Emulation.setDefaultBackgroundColorOverride',{'color':{'r':0,'g':0,'b':0,'a':0}},session=session)
        for size in (16,32,48,128):
            ws.call('Emulation.setDeviceMetricsOverride',{'width':size,'height':size,'deviceScaleFactor':1,'mobile':False},session=session)
            markup='<style>html,body{margin:0;background:transparent;overflow:hidden}svg{width:100vw;height:100vh;display:block}</style>'+svg
            ws.call('Runtime.evaluate',{'expression':'document.documentElement.innerHTML='+json.dumps(markup)},session=session)
            data=ws.call('Page.captureScreenshot',{'format':'png'},session=session)['data']
            path=ROOT/'icons'/f'icon{size}.png';path.write_bytes(base64.b64decode(data));print(path.relative_to(ROOT))
    return 0

if __name__=='__main__':raise SystemExit(main())
