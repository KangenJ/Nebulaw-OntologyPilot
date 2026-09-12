"""Independent serving implementation; never imports experimental runtime code.

Mechanism compatibility: P36b coefficient R, P40 uniform Bayes32 H,
fixed-kernel latent propagation, explicit H -> E mapping. No training here.
"""
import hashlib
import io
import itertools
import math
from pathlib import Path

import numpy as np
import torch
from torch import nn

VERSION = 'local-dynamics-v1-p36b61-bayes32'
WEIGHT_HASH = '92579351b915f59550c56af870d14d66e554b734f7c6f9cb31a0d94b2733cd04'
H = ('OBSERVED_TRUE', 'OBSERVED_FALSE', 'MISSING')
E = ('SUPPORTED', 'REFUTED', 'NOT_PROVED')
CELLS = list(itertools.product((0, 1), repeat=3))


class ContractError(ValueError):
    pass


def exact(obj, fields, name):
    if not isinstance(obj, dict) or set(obj) != set(fields):
        raise ContractError(f'{name}: explicit fields required: {", ".join(fields)}')


def binary(value):
    if type(value) is not int or value not in (0, 1):
        raise ContractError('Binary fields must be integer 0 or 1')


def validate(data):
    exact(data, ['initialAction', 'behaviorDemonstrations', 'observationDemonstrations', 'options'], 'request')
    binary(data['initialAction'])
    for key, limit in [('behaviorDemonstrations', 24), ('observationDemonstrations', 16)]:
        if not isinstance(data[key], list) or len(data[key]) > limit:
            raise ContractError(f'{key}: at most {limit} rows')
    for d in data['behaviorDemonstrations']:
        exact(d, ['l', 'f', 'prev_action', 'requested_action', 'next_action'], 'behavior demonstration')
        for value in d.values():
            binary(value)
    for d in data['observationDemonstrations']:
        exact(d, ['alignment', 'probe', 'outcome'], 'observation demonstration')
        binary(d['alignment']); binary(d['probe'])
        if d['outcome'] not in H:
            raise ContractError('Observation outcome must be OBSERVED_TRUE, OBSERVED_FALSE or MISSING')
    if not isinstance(data['options'], list) or not 2 <= len(data['options']) <= 4:
        raise ContractError('Compare 2–4 options')
    depths, names = set(), set()
    for option in data['options']:
        exact(option, ['name', 'schedule', 'costAct', 'costRefrain', 'interventionCost'], 'option')
        if not isinstance(option['name'], str) or not option['name'].strip() or len(option['name']) > 80 or option['name'] in names:
            raise ContractError('Distinct bounded option names required')
        names.add(option['name'])
        if not isinstance(option['schedule'], list) or len(option['schedule']) not in (2, 3):
            raise ContractError('Only 2 or 3 step schedules are validated')
        depths.add(len(option['schedule']))
        for step in option['schedule']:
            exact(step, ['requested_action', 'l', 'f', 'probe'], 'step')
            for value in step.values():
                binary(value)
        for key in ('costAct', 'costRefrain', 'interventionCost'):
            v = option[key]
            if type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 1e6:
                raise ContractError('Finite bounded costs required')
    if len(depths) != 1:
        raise ContractError('Compared options must have the same horizon')


class CoefficientNetwork(nn.Module):
    """Serving-only, checkpoint-compatible small network; no attention or tokenizer."""
    def __init__(self):
        super().__init__()
        self.demo_encoder = nn.Sequential(nn.Linear(8, 64), nn.SiLU(), nn.Linear(64, 64), nn.SiLU())
        self.coefficient_readout = nn.Sequential(nn.Linear(134, 96), nn.SiLU(), nn.Linear(96, 64), nn.SiLU(), nn.Linear(64, 4))

    def encode(self, demonstrations):
        n = len(demonstrations)
        if n:
            x = torch.tensor([[d['l'], d['f'], int(d['prev_action'] == d['requested_action']), int(d['next_action'] == d['requested_action'])] for d in demonstrations], dtype=torch.float32) * 2 - 1
            y = x[:, 3:4]
            token = torch.cat((x, y * x[:, :3], torch.ones(n, 1)), dim=1)
            encoded = self.demo_encoder(token).sum(0, keepdim=True)
            direct = torch.cat((y, y * x[:, :3]), dim=1).mean(0, keepdim=True)
        else:
            encoded, direct = torch.zeros(1, 64), torch.zeros(1, 4)
        return torch.cat((encoded / 24, encoded / max(n, 1), direct, torch.tensor([[float(n > 0), n / 24]])), dim=1)

    def forward(self, demonstrations):
        summary = self.encode(demonstrations)
        coefficients = self.coefficient_readout(summary)[0]
        cells = torch.tensor(CELLS, dtype=torch.float32) * 2 - 1
        return coefficients, torch.sigmoid(coefficients[0] + cells @ coefficients[1:])


def catalogue():
    """Explicit 32-member observation prior, NOT a learned observation network.

Uniform member prior matches the P39/P40 benchmark, not P30's family prior.
Contains no selected family, private ground truth or future labels.
"""
    tables = []
    for hi, lo, missing in itertools.product((.97, .995), (.50, .55), (.05, .15)):
        for structure, orientation in [('single', 0), ('single', 1), ('match', None), ('mismatch', None)]:
            table = np.empty((2, 2, 3))
            for aligned, probe in itertools.product((0, 1), repeat=2):
                degraded = probe == orientation if structure == 'single' else (probe == aligned if structure == 'match' else probe != aligned)
                correct = (1 - missing) * (lo if degraded else hi)
                incorrect = 1 - missing - correct
                table[aligned, probe] = (correct, incorrect, missing) if aligned else (incorrect, correct, missing)
            tables.append(table)
    return np.asarray(tables)


def observation_kernel(demonstrations):
    tables = catalogue()
    log_weights = np.zeros(32)
    for d in demonstrations:
        log_weights += np.log(tables[:, d['alignment'], d['probe'], H.index(d['outcome'])])
    weights = np.exp(log_weights - log_weights.max())
    weights /= weights.sum()
    return np.einsum('n,nabh->abh', weights, tables), weights


def propagate(r_kernel, h_kernel, initial, schedule):
    """Exact dynamic programming over estimated kernels, not parameter posterior integration."""
    # (previous physical R, observed H prefix) -> probability
    mass = {(initial, ()): 1.0}
    for step in schedule:
        next_mass = {}
        for (previous, history), probability in mass.items():
            req = step['requested_action']
            alignment_p = r_kernel[4 * step['l'] + 2 * step['f'] + int(previous == req)]
            for physical in (0, 1):
                aligned = int(physical == req)
                p_r = alignment_p if aligned else 1 - alignment_p
                for h in range(3):
                    key = (physical, history + (h,))
                    next_mass[key] = next_mass.get(key, 0.0) + probability * p_r * h_kernel[aligned, step['probe'], h]
        mass = next_mass
    joint = np.zeros(3 ** len(schedule)); final_r = np.zeros(2)
    for (physical, history), probability in mass.items():
        index = 0
        for h in history:
            index = index * 3 + h
        joint[index] += probability; final_r[physical] += probability
    final_h = joint.reshape(-1, 3).sum(0)
    for distribution in (joint, final_r, final_h):
        if not np.isfinite(distribution).all() or distribution.min() < 0 or not np.isclose(distribution.sum(), 1, atol=2e-6):
            raise RuntimeError('Invalid probability distribution')
    return joint, final_r, final_h


class Dynamics:
    def __init__(self, checkpoint):
        self.path = Path(checkpoint)
        weights = self.path.read_bytes()
        if hashlib.sha256(weights).hexdigest() != WEIGHT_HASH:
            raise RuntimeError('Unapproved checkpoint hash; refusing startup')
        torch.set_num_threads(1)
        self.network = CoefficientNetwork().eval()
        self.network.load_state_dict(torch.load(io.BytesIO(weights), map_location='cpu', weights_only=True), strict=True)
        self.code_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        for p in self.network.parameters():
            p.requires_grad_(False)

    def status(self):
        return {'ready': True, 'version': VERSION, 'checkpointHash': WEIGHT_HASH, 'implementationHash': self.code_hash,
                'torchVersion': torch.__version__, 'numpyVersion': np.__version__,
                'model': 'P36b seed61 coefficient neural R + analytical Bayes32 H + explicit E',
                'parameters': sum(p.numel() for p in self.network.parameters()),
                'device': 'cpu', 'transformer': False, 'weightsFrozen': True,
                'generalLwm': False, 'productionCertified': False,
                'learningAvailable': True,
                'updateScope': 'Immutable serving snapshots; governed offline updates to 260 neural head parameters, H and E unchanged'}

    def infer(self, data):
        # Per-request immutable model selection comes from the native registry.
        artifact_json = data.get('artifactJson', 'null')
        if 'artifactJson' in data:
            data = {k: v for k, v in data.items() if k != 'artifactJson'}
        validate(data)
        from learning import network_for, artifact_hash
        network = network_for(self.network, artifact_json)
        with torch.inference_mode():
            coeff, rk = network(data['behaviorDemonstrations'])
        hk, posterior = observation_kernel(data['observationDemonstrations'])
        predictions = []
        for option in data['options']:
            joint, final_r, final_h = propagate(rk.numpy().astype(float), hk, data['initialAction'], option['schedule'])
            p = float(final_r[1])
            predictions.append({**option, 'baseProbability': p, 'actProbability': p,
                'expectedCost': p * option['costAct'] + (1-p) * option['costRefrain'] + option['interventionCost'],
                'finalR': dict(zip(('REFRAIN', 'ACT'), final_r.tolist())),
                'finalH': dict(zip(H, final_h.tolist())), 'finalE': dict(zip(E, final_h.tolist())),
                'jointHSequence': joint.tolist(),
                'uncertainty': 'Predictive probabilities under explicit assumptions, not confidence intervals or legal conclusions'})
        return {**self.status(), 'modelKind': 'research-dynamics-v1', 'options': predictions,
                'modelHash': artifact_hash(artifact_json), 'learnedHead': artifact_json != 'null',
                'recommendedIndex': min(range(len(predictions)), key=lambda i: predictions[i]['expectedCost']),
                'coefficients': coeff.tolist(), 'alignmentKernel': rk.tolist(), 'observationKernel': hk.tolist(),
                'observationPosterior': posterior.tolist(),
                'eRule': dict(zip(H, E)), 'onticRWrite': False, 'businessFactsWritten': False,
                'limitations': ['Restricted binary mechanism family and 2/3-step horizons',
                    'H uses an explicit closed catalogue, not a learned module',
                    'Fixed estimated Markov kernels, no gold-state reset or parameter-posterior integration',
                    'No autonomous legal validity inference; no production effectiveness claim']}
