#!/usr/bin/env python3
import json
from pathlib import Path

path = Path("/home/ubuntu/.devspace/config.json")
data = json.loads(path.read_text(encoding="utf-8"))
roots = list(dict.fromkeys([
    *data.get("allowedRoots", []),
    "/home/ubuntu/minecraft",
]))
data["allowedRoots"] = roots
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
path.chmod(0o600)
print("allowed_roots_updated=yes")
