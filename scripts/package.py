"""Build the unpacked extension ZIP using only Python's standard library."""
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "page-translator"
FILES = (
    "manifest.json", "background.js", "languages.js", "local-translator.js", "content.js",
    "popup.html", "popup.css", "popup.js",
)


def main():
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    for name in FILES:
        if not (SOURCE / name).is_file():
            raise FileNotFoundError(name)
    output = ROOT / "dist" / "page-translator.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (SOURCE / name).read_bytes())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or sorted(archive.namelist()) != sorted(FILES):
            raise RuntimeError("ZIP verification failed")
    print(f"Built v{manifest['version']}: {output} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
