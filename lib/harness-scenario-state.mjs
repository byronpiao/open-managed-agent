/** Active harness matrix cell — process-local only (never `process.env`). */

let activeScenario = "";

export function setHarnessScenario(id) {
  activeScenario = id?.trim() || "";
}

export function getHarnessScenario() {
  return activeScenario;
}

export function clearHarnessScenario() {
  activeScenario = "";
}
