#!/usr/bin/env python3
"""
Build the packed int8 potion-code-16M model blob that ships to R2, and the mini
blob fixture used by test/potion-int8.test.ts.

Reads the model.safetensors the V3Code editor caches at
  ~/.v3code/models/minishlab__potion-code-16M/model.safetensors
(mapping I64[V] | weights F64[V] | embeddings F32[V,256]) and packs a compact,
little-endian blob the Worker parses with parseStaticModel():

  dim:u32 | V:u32 | rows:u32 | scale:f32 | normalize:u8 | unkId:u32
  mapping:i32[V] | weights:f32[V] | embeddings:i8[rows*dim]

int8 = round(f32 / scale), scale = max|f32| / 127 (global). ~16MB vs 63MB f32, so it
fits the 128MB Worker isolate; cosine to f32 is >0.998 (test/potion-embed vs int8).

Upload:
  wrangler r2 object put v3index-blobs/models/potion-code-16M-int8-v1.bin \
    --file=/tmp/potion-code-16M-int8-v1.bin --remote
"""
import json, struct, math, base64, os

HOME = os.path.expanduser('~')
MODEL = f'{HOME}/.v3code/models/minishlab__potion-code-16M/model.safetensors'
UNK = 1
OUT_FULL = '/tmp/potion-code-16M-int8-v1.bin'
OUT_MINI = 'test/fixtures-potion-int8.json'
TOK_FIX = 'test/fixtures-potion-tok.json'

f = open(MODEL, 'rb')
hlen = struct.unpack('<Q', f.read(8))[0]
header = json.loads(f.read(hlen).decode('utf8'))
ds = 8 + hlen

def tb(n):
    e = header[n]; s, en = e['data_offsets']; f.seek(ds + s); return f.read(en - s), e

mraw, me = tb('mapping'); V = me['shape'][0]; mapping = list(struct.unpack('<%dq' % V, mraw))
wraw, _ = tb('weights'); weights = list(struct.unpack('<%dd' % V, wraw))
emb = header['embeddings']; dim = emb['shape'][1]; rows = emb['shape'][0]; emboff = ds + emb['data_offsets'][0]
f.seek(emboff); vals = struct.unpack('<%df' % (rows * dim), f.read(rows * dim * 4))
scale = max(abs(v) for v in vals) / 127.0
def q(v): return max(-127, min(127, round(v / scale)))

# FULL blob → R2 (with vocab tail so the Worker tokenizes without a bundled JSON import)
vjson = json.dumps(json.load(open(f'{HOME}/.v3code/models/minishlab/potion-code-16M/tokenizer.json'))['model']['vocab'], separators=(',', ':')).encode('utf8')
hdr = struct.pack('<IIIfBI', dim, V, rows, scale, 1, UNK)
blob = hdr + struct.pack('<%di' % V, *[int(x) for x in mapping]) + struct.pack('<%df' % V, *weights) \
    + bytes((q(v) & 0xff) for v in vals) + struct.pack('<I', len(vjson)) + vjson
open(OUT_FULL, 'wb').write(blob)
print(f'FULL blob {len(blob)} bytes ({len(blob)/1e6:.2f} MB) scale={scale:.6f} vocab={len(vjson)}B -> {OUT_FULL}')

# MINI blob → worker test fixture (compact model over the tokenizer fixture's ids)
def row(r): return vals[r * dim:(r + 1) * dim]
fixtures = json.load(open(TOK_FIX))
used, seen = [], set()
for fx in fixtures:
    for i in fx['ids']:
        if i != UNK and i not in seen: seen.add(i); used.append(i)
remap = {o: c for c, o in enumerate(used)}; M = len(used)
mini = struct.pack('<IIIfBI', dim, M, M, scale, 1, M) + struct.pack('<%di' % M, *range(M)) \
    + struct.pack('<%df' % M, *[weights[o] for o in used]) \
    + bytes((q(v) & 0xff) for o in used for v in row(mapping[o]))
def ref(ids):
    acc = [0.0] * dim; c = 0
    for i in ids[:512]:
        if i == UNK: continue
        rr = mapping[i]
        if rr < 0: continue
        r = row(rr); w = weights[i]
        for d in range(dim): acc[d] += r[d] * w
        c += 1
    if c == 0: return [0.0] * dim
    n = math.sqrt(sum((x / c) ** 2 for x in acc)) + 1e-32
    return [(x / c) / n for x in acc]
cases = [{'text': fx['text'], 'ids': [remap.get(i, M) for i in fx['ids']], 'vec': ref(fx['ids'])} for fx in fixtures]
json.dump({'blobB64': base64.b64encode(mini).decode(), 'cases': cases}, open(OUT_MINI, 'w'))
print(f'MINI blob {len(mini)} bytes | {len(cases)} cases -> {OUT_MINI}')
