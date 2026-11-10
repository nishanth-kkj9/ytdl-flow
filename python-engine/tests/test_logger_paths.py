import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import logger  # noqa: E402


def test_log_path_uses_configured_user_data_directory(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"
    monkeypatch.setenv("YTDL_LOG_DIR", str(log_dir))
    monkeypatch.setattr(logger, "_log_path", None)
    monkeypatch.setattr(logger, "_log_date", None)

    log_path = logger._get_log_path()

    assert os.path.dirname(log_path) == str(log_dir)
    assert log_dir.is_dir()
