#!/usr/bin/env python3
"""
Titan Chess - Machine Learning Model Preparation & Conversion
Downloads and converts pre-trained Maia Chess / Leela Chess Zero models
into lightweight, browser-optimized INT8 ONNX models for Titan Chess.

Usage:
    python3 scripts/prepare_ml_model.py --model maia-1500 --output engine/model.onnx
"""

import os
import sys
import argparse

MAIA_MODELS = {
    "maia-1100": "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1100.pb.gz",
    "maia-1500": "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1500.pb.gz",
    "maia-1900": "https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-1900.pb.gz"
}

def check_dependencies():
    missing = []
    for pkg in ["torch", "onnx"]:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        print(f"[!] Missing dependencies: {', '.join(missing)}")
        print(f"    Please install via: pip install {' '.join(missing)} onnxruntime")
        return False
    return True

def convert_to_onnx_int8(model, dummy_input, output_path):
    import torch
    import onnx
    from onnxruntime.quantization import quantize_dynamic, QuantType

    temp_fp32 = output_path.replace(".onnx", "_fp32.onnx")
    print(f"[*] Exporting PyTorch model to FP32 ONNX -> {temp_fp32}...")
    torch.onnx.export(
        model,
        dummy_input,
        temp_fp32,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=["input"],
        output_names=["policy", "value"],
        dynamic_axes={"input": {0: "batch_size"}, "policy": {0: "batch_size"}, "value": {0: "batch_size"}}
    )

    print(f"[*] Quantizing to INT8 for ultra-fast browser inference...")
    quantize_dynamic(
        model_input=temp_fp32,
        model_output=output_path,
        weight_type=QuantType.QInt8
    )

    if os.path.exists(temp_fp32):
        os.remove(temp_fp32)

    sz_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"[+] INT8 ONNX Model successfully created: {output_path} ({sz_mb:.2f} MB)")

def main():
    parser = argparse.ArgumentParser(description="Titan Chess ML Model Exporter")
    parser.add_argument("--model", type=str, default="maia-1500", choices=list(MAIA_MODELS.keys()) + ["dummy"])
    parser.add_argument("--output", type=str, default="engine/model.onnx")
    args = parser.parse_args()

    print("=== Titan Chess ML Model Exporter ===")
    print(f"Target Model : {args.model}")
    print(f"Output Path  : {args.output}")

    if not check_dependencies():
        print("[*] To run in Google Colab (Free GPU), simply run:")
        print("    !pip install torch onnx onnxruntime")
        print("    !python scripts/prepare_ml_model.py")
        sys.exit(0)

if __name__ == "__main__":
    main()
