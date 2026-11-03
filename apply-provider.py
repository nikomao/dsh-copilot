import os, re, json, time, urllib.request, yaml, sys
cfg = os.environ.get('CFG') or os.path.expanduser('~/.dsh/profiles/desktop/cordis.patch.yml')
src = open(cfg, encoding='utf-8').read()
if 'copilot-api:' in src:
    print('already configured'); sys.exit(0)
models = json.load(urllib.request.urlopen('http://127.0.0.1:17866/v1/models', timeout=30))['data']
resp = [m for m in models if (m.get('endpoints') or []) and '/responses' in m['endpoints']]
if not resp:
    print('no responses models from bridge'); sys.exit(1)
m = re.search(r'^( +)copilot:\s*$', src, re.M)
if not m:
    print('copilot block not found'); sys.exit(1)
ind = m.group(1)
lines = [f'{ind}copilot-api:', f'{ind}  displayName: GitHub Copilot (直连)',
         f'{ind}  apiKeyEnv: COPILOT_BRIDGE_TOKEN', f'{ind}  api: openai-responses',
         f'{ind}  baseURL: http://127.0.0.1:17866/v1', f'{ind}  models:']
for x in resp:
    lines += [f"{ind}  - id: {x['id']}",
              f"{ind}    name: {x.get('name') or x['id']}",
              f"{ind}    contextWindow: {x.get('context_window') or 200000}",
              f"{ind}    maxTokens: {x.get('max_output_tokens') or 64000}",
              f"{ind}    input: [text, image]"]
block = '\n'.join(lines) + '\n\n'
out = src[:m.start()] + block + src[m.start():]
open(cfg + '.bak-' + time.strftime('%Y%m%d%H%M%S'), 'w', encoding='utf-8').write(src)
open(cfg, 'w', encoding='utf-8').write(out)
d = yaml.safe_load(open(cfg, encoding='utf-8'))
p = [e for e in d if e.get('id') == 'llm-pi-ai'][0]['config']['providers']
print('OK providers:', list(p.keys()))
print('copilot-api:', len(p['copilot-api']['models']), 'models;', p['copilot-api']['models'][0])
