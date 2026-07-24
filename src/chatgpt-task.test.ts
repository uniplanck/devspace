import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfiguredProjectUrl } from "./chatgpt-task.js";

const root = await mkdtemp(join(tmpdir(), "devspace-chatgpt-project-"));
try {
  const configProjectUrl = "https://chatgpt.com/g/g-p-config/project";
  const environmentProjectUrl = "https://chatgpt.com/g/g-p-environment/project";
  const explicitProjectUrl = "https://chatgpt.com/g/g-p-explicit/project";

  await writeFile(
    join(root, "config.json"),
    `${JSON.stringify({ chatgptProjectUrl: configProjectUrl }, null, 2)}\n`,
  );

  assert.equal(
    applyConfiguredProjectUrl(
      { prompt: "config" },
      { DEVSPACE_CONFIG_DIR: root },
    ).url,
    configProjectUrl,
  );

  assert.equal(
    applyConfiguredProjectUrl(
      { prompt: "environment" },
      {
        DEVSPACE_CONFIG_DIR: root,
        DEVSPACE_CHATGPT_PROJECT_URL: environmentProjectUrl,
      },
    ).url,
    environmentProjectUrl,
  );

  assert.equal(
    applyConfiguredProjectUrl(
      { prompt: "explicit", url: explicitProjectUrl },
      {
        DEVSPACE_CONFIG_DIR: root,
        DEVSPACE_CHATGPT_PROJECT_URL: environmentProjectUrl,
      },
    ).url,
    explicitProjectUrl,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
