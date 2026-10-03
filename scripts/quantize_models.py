# Weight-only int8 quantization of the vendored ONNX models (spec-web §16): every Conv/ConvTranspose
# weight is stored as per-output-channel symmetric int8 + a DequantizeLinear back to its original
# dtype, so compute (and WebGPU/wasm support) is unchanged and only the download shrinks ~4x (fp32)
# or ~2x (fp16). Sources in models/ (not deployed) -> public/models/ (served, same file names).
# Run: python scripts/quantize_models.py   (needs: pip install onnx numpy)
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

def quantize(src: str, dst: str) -> None:
    m = onnx.load(src)
    g = m.graph
    inits = {i.name: i for i in g.initializer}
    consts = {n.output[0]: n for n in g.node if n.op_type == 'Constant' and n.attribute and n.attribute[0].name == 'value'}
    weights = {n.input[1] for n in g.node if n.op_type in ('Conv', 'ConvTranspose') and len(n.input) > 1}
    new_nodes, done = [], 0
    for name in sorted(weights):
        if name in inits:
            arr = numpy_helper.to_array(inits[name]); g.initializer.remove(inits[name])
        elif name in consts:
            arr = numpy_helper.to_array(consts[name].attribute[0].t); g.node.remove(consts[name])
        else:
            continue
        w = arr.astype(np.float32)
        axis = 1 if any(n.op_type == 'ConvTranspose' and n.input[1] == name for n in g.node) else 0
        red = tuple(i for i in range(w.ndim) if i != axis)
        scale = np.maximum(np.abs(w).max(axis=red), 1e-12) / 127.0
        shape = [1] * w.ndim; shape[axis] = -1
        q = np.clip(np.round(w / scale.reshape(shape)), -127, 127).astype(np.int8)
        g.initializer.extend([numpy_helper.from_array(q, name + '_q'), numpy_helper.from_array(scale.astype(np.float32), name + '_s'),
                              numpy_helper.from_array(np.zeros_like(scale, dtype=np.int8), name + '_z')])
        if arr.dtype == np.float16:
            new_nodes += [helper.make_node('DequantizeLinear', [name + '_q', name + '_s', name + '_z'], [name + '_f32'], axis=axis),
                          helper.make_node('Cast', [name + '_f32'], [name], to=TensorProto.FLOAT16)]
        else:
            new_nodes.append(helper.make_node('DequantizeLinear', [name + '_q', name + '_s', name + '_z'], [name], axis=axis))
        done += 1
    nodes = new_nodes + list(g.node)
    del g.node[:]
    g.node.extend(nodes)
    for op in m.opset_import:
        if op.domain in ('', 'ai.onnx') and op.version < 13:
            op.version = 13   # per-axis DequantizeLinear
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    print(f'{src}: {done} weights -> {dst}')

if __name__ == '__main__':
    for name in sys.argv[1:] or ['uvdoc', 'ch_PP-OCRv4_det']:
        quantize(f'models/{name}.onnx', f'public/models/{name}.onnx')
