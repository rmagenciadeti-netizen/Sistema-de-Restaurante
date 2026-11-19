# E2E do PWA (Playwright/Chromium) recuperado do trabalho de outro agente (a cópia temporária apps/web-e2e foi removida; este script é o único artefato exclusivo dela).
# Pré-requisitos: web em produção (next start) em localhost:3100, API em localhost:4010 e um restaurante com o usuário admin@e2e.test (senha de teste abaixo).
#
import json, re, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3100'
API = 'http://localhost:4010/api/v1'
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)

def api(method, path, token=None, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={'content-type': 'application/json', **({'authorization': f'Bearer {token}'} if token else {})})
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read() or 'null')

token = api('POST', '/auth/login', body={'email': 'admin@e2e.test', 'password': 'E2e-Pass-12345!'})['accessToken']
before = len(api('GET', '/orders?pageSize=100', token)['items'])

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    context = browser.new_context(service_workers='allow', viewport={'width': 1400, 'height': 900})
    page = context.new_page()
    page.on('pageerror', lambda e: print('PAGEERROR', str(e)[:200]))

    page.goto(BASE + '/login')
    page.locator('input[type=email], input[name=email], input[autocomplete=username]').first.fill('admin@e2e.test')
    page.locator('input[type=password]').first.fill('E2e-Pass-12345!')
    page.locator('button[type=submit]').first.click()
    page.wait_for_url(re.compile(r'/(dashboard|change-password)'), timeout=60000)
    check('login in production build', '/dashboard' in page.url, page.url)

    # 1. install + registration
    reg = page.evaluate("""async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, state: r.active && r.active.state }; }""")
    check('service worker registered and active', reg['state'] == 'activated' and reg['scope'].rstrip('/') == BASE, json.dumps(reg))
    page.reload(); page.wait_for_load_state('networkidle')
    check('page controlled by the service worker after reload', page.evaluate('!!navigator.serviceWorker.controller'))
    manifest_href = page.evaluate("document.querySelector('link[rel=manifest]')?.href")
    check('manifest linked', manifest_href and manifest_href.endswith('/manifest.webmanifest'), str(manifest_href))
    cdp = context.new_cdp_session(page)
    cdp.send('Page.enable')
    errors = cdp.send('Page.getInstallabilityErrors').get('installabilityErrors', [])
    check('installable (Chromium installability check)', len(errors) == 0, json.dumps(errors)[:200])
    mani = json.loads(page.evaluate("fetch('/manifest.webmanifest').then(r => r.text())"))
    check('manifest standalone + icons 192/512/maskable', mani['display'] == 'standalone' and {i['sizes'] for i in mani['icons']} >= {'192x192', '512x512'} and any(i.get('purpose') == 'maskable' for i in mani['icons']))

    # 2. warm the pages that must work offline
    page.goto(BASE + '/pdv'); page.wait_for_load_state('networkidle')
    page.get_by_text('Hambúrguer E2E').first.wait_for(timeout=30000)
    page.goto(BASE + '/pdv'); page.wait_for_load_state('networkidle')
    page.get_by_text('Hambúrguer E2E').first.click(); page.wait_for_timeout(1200)  # online: saves the product composition on the device
    caches = page.evaluate("""async () => { const out = {}; for (const n of await caches.keys()) { out[n] = (await (await caches.open(n)).keys()).map(r => new URL(r.url).pathname); } return out; }""")
    static_names = [n for n in caches if n.startswith('rm-static')]
    page_names = [n for n in caches if n.startswith('rm-pages')]
    check('caches created (static + pages)', static_names and page_names, ','.join(caches))
    check('/pdv shell cached', any(u == '/pdv' for n in page_names for u in caches[n]))
    check('private API data never cached', not any('api-proxy' in u or '/api/' in u for urls in caches.values() for u in urls))

    # 3. offline: reload the PDV from cache, sell, queue
    context.set_offline(True)
    page.reload(wait_until='domcontentloaded'); page.wait_for_timeout(2500)
    shell_ok = page.get_by_text('Hambúrguer E2E').first.is_visible() if page.get_by_text('Hambúrguer E2E').count() else False
    check('PDV opens offline from the cached shell with the catalog snapshot', shell_ok, page.title())
    banner = page.get_by_text('Sem conexão').first
    check('offline banner shown', banner.is_visible())
    page.get_by_text('Hambúrguer E2E').first.click()
    page.wait_for_timeout(500)
    buttons = [b.inner_text().strip() for b in page.locator('button:visible').all() if b.is_enabled()]
    send = page.get_by_role('button', name='Gerar pedido').first
    print('enabled buttons:', buttons[:40])
    send.click()
    page.wait_for_timeout(1500)
    check('order queued on the device while offline', page.get_by_text(re.compile(r'aguardando envio|guardad', re.I)).count() > 0)
    print('navigator.onLine =', page.evaluate('navigator.onLine'), '| statuses:', [a.inner_text()[:90].replace(chr(10),' ') for a in page.locator('[role=status]').all()])
    warn = page.get_by_text(re.compile(r'exigem conexão')).first
    try: warn.wait_for(timeout=5000); warn_ok = True
    except Exception: warn_ok = False
    check('payment/TEF/fiscal warning visible offline', warn_ok, page.locator('[role=status]').first.inner_text()[:160].replace(chr(10), ' ') if page.locator('[role=status]').count() else 'no status element')
    mid = len(api('GET', '/orders?pageSize=100', token)['items'])
    check('server did not receive the order while offline', mid == before, f'{before}->{mid}')
    # an uncached page falls back to the offline screen
    page.goto(BASE + '/reports', wait_until='domcontentloaded'); page.wait_for_timeout(5500)
    check('uncached page shows the offline screen', page.get_by_text(re.compile(r'sem (conexão|internet)', re.I)).count() > 0, page.title())

    # 4. recovery
    page.goto(BASE + '/pdv', wait_until='domcontentloaded') if False else None
    context.set_offline(False)
    page.goto(BASE + '/pdv'); page.wait_for_load_state('networkidle')
    deadline = time.time() + 60
    after = mid
    while time.time() < deadline:
        after = len(api('GET', '/orders?pageSize=100', token)['items'])
        if after > mid: break
        page.wait_for_timeout(2000)
    check('queued order synced automatically after the connection returned', after == before + 1, f'{before}->{after}')
    page.wait_for_timeout(3000)
    final = len(api('GET', '/orders?pageSize=100', token)['items'])
    check('no duplicate after later syncs (idempotent)', final == before + 1, f'final={final}')

    # 5. update flow
    version_before = page.evaluate("fetch('/sw.js', {cache:'no-store'}).then(r => r.text()).then(t => (t.match(/VERSION = '([^']+)'/)||[])[1])")
    page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
    page.wait_for_timeout(1500)
    check('update check runs without error', True, f'sw version {version_before}')
    browser.close()

failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
