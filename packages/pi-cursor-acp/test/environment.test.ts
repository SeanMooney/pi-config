import assert from "node:assert/strict";
import test from "node:test";

import { cursorChildEnvironment } from "../environment.js";

test("forwards required runtime variables and removes credentials", () => {
  const environment = cursorChildEnvironment(
    {
      HOME: "/home/user",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.example",
      OPENAI_API_KEY: "openai-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GH_TOKEN: "github-secret",
      CURSOR_ACCESS_TOKEN: "cursor-secret",
      PI_SESSION_TOKEN: "pi-secret",
    },
    {
      CURSOR_CONFIG_DIR: "/workspace/.tmp/cursor-config",
      PI_CURSOR_ACP_WORKSPACE: "/workspace",
    },
  );

  assert.deepEqual(environment, {
    HOME: "/home/user",
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "C.UTF-8",
    HTTPS_PROXY: "http://proxy.example",
    CURSOR_CONFIG_DIR: "/workspace/.tmp/cursor-config",
    PI_CURSOR_ACP_WORKSPACE: "/workspace",
  });
});
