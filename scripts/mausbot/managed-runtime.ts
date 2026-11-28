// Capture the parent launch mode once and keep it out of provider subprocesses.
export const managedRuntime = process.env.J1_MAUSBOT_MANAGED === "1";
delete process.env.J1_MAUSBOT_MANAGED;
