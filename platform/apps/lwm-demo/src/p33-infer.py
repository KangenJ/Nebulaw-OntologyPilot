"""Read-only adapter to the existing P33 trained research checkpoint.

No generator, oracle, training or target labels enter inference. Predictions
are binary physical behavior, NOT legal validity or a general LWM capability.
"""
import hashlib
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root))
import torch
from runtime.p33_behavior_bridge_model_v0_9 import PublicBehaviorBridgeDeepSets

torch.set_num_threads(1)
checkpoint = root / 'artifacts/p33_behavior_bridge_seed61_r1/model_seed61_final.pt'
payload = json.load(sys.stdin)
fields = ['l', 'f', 'prev_action', 'requested_action', 'lawfulness']
queries = payload['queries']
demos = payload.get('demonstrations', [])
if not 1 <= len(queries) <= 32 or len(demos) > 24:
    raise ValueError('P33 accepts 1–32 queries and at most 24 demonstrations')
for row in queries:
    if set(row) != set(fields) or any(type(row[f]) is not int or row[f] not in (0, 1) for f in fields):
        raise ValueError('Public query contract violated')
for row in demos:
    if set(row) != set(fields + ['next_action']) or any(type(row[f]) is not int or row[f] not in (0, 1) for f in fields + ['next_action']):
        raise ValueError('Public demonstration contract violated')
saved = torch.load(checkpoint, map_location='cpu', weights_only=True)
if saved['schema'] != 'lde.v0.9.p33-behavior-bridge-stage2.v1':
    raise ValueError('Unexpected checkpoint schema')
model = PublicBehaviorBridgeDeepSets()
model.load_state_dict(saved['model_state_dict'], strict=True)
model.eval()
args = {f'demo_{f}': torch.tensor([[d[f] for d in demos]], dtype=torch.long) for f in fields + ['next_action']}
args['demo_mask'] = torch.ones((1, len(demos)), dtype=torch.bool)
args.update({f'query_{f}': torch.tensor([[q[f] for q in queries]], dtype=torch.long) for f in fields})
with torch.inference_mode():
    result = model(**args)
print(json.dumps({'probabilities': result.probabilities[0].tolist(),
    'model': 'P33 PublicBehaviorBridgeDeepSets seed61',
    'checkpointHash': hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
    'sourceHash': hashlib.sha256((root / 'runtime/p33_behavior_bridge_model_v0_9.py').read_bytes()).hexdigest(),
    'parameters': sum(p.numel() for p in model.parameters()),
    'contract': 'P33 public binary K/I/R → P(REFRAIN), P(ACT)',
    'limitations': 'Synthetic research task; not legal validity, causal identification or general LWM'}))
