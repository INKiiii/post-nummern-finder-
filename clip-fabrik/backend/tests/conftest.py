"""Gemeinsame Test-Umgebung: frisches Datenverzeichnis + DB pro Test, Fake-KI, Mock-Publisher."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

os.environ.setdefault("CLIPFABRIK_FAKE_AI", "1")
os.environ.setdefault("ENABLE_MOCK_PUBLISHER", "1")
os.environ["ADMIN_PASSWORD"] = "test-passwort-123"
os.environ["SECRET_KEY"] = "test-secret-key-0123456789abcdef"
os.environ.setdefault("LOG_LEVEL", "WARNING")

PASSWORD = "test-passwort-123"


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from clipfabrik import db
    from clipfabrik.config import reset_settings_cache

    d = tmp_path / "data"
    monkeypatch.setenv("DATA_DIR", str(d))
    monkeypatch.setenv("PUBLIC_URL", "https://clips.example.test")
    reset_settings_cache()
    db.reset_engine()
    db.init_engine()
    yield d
    db.reset_engine()
    reset_settings_cache()


@pytest.fixture()
def client(data_dir: Path):
    from fastapi.testclient import TestClient

    from clipfabrik.api.app import create_app

    app = create_app()
    with TestClient(app, base_url="https://testserver") as c:
        r = c.post("/api/auth/login", json={"password": PASSWORD})
        assert r.status_code == 200, r.text
        yield c


def run_jobs(max_jobs: int = 200, types: list[str] | None = None) -> int:
    from clipfabrik.jobs.worker import run_one

    n = 0
    while n < max_jobs and run_one("test-worker", types):
        n += 1
    return n


from clipfabrik.devtools.synthetic import SCRIPT, chat_burst, has_flite, make_test_video  # noqa: E402,F401


@pytest.fixture(scope="session")
def test_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg fehlt")
    return make_test_video(tmp_path_factory.mktemp("video") / "stream.mp4")
