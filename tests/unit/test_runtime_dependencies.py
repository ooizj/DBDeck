"""运行时依赖必须显式写在 requirements.txt 里，不能依赖其他包间接带入。

python-multipart 曾经只是 mcp 的间接依赖；去掉 mcp 后打包出的桌面应用在启动时
因导入接口使用 File / Form 参数而直接崩溃。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _declared_packages() -> set[str]:
    names = set()
    for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.add(line.split("==", 1)[0].split(">=", 1)[0].strip().lower())
    return names


def test_form_upload_routes_declare_python_multipart():
    uses_forms = any(
        "UploadFile" in path.read_text(encoding="utf-8") or "Form(" in path.read_text(encoding="utf-8")
        for path in (ROOT / "src" / "api").glob("*.py")
    )
    assert uses_forms
    assert "python-multipart" in _declared_packages()
