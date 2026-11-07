/** Keep provider credentials and OS configuration, without inheriting either application's private runtime. */
export function mausbotChildEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^(?:OMB_|OPENMAUSBOT_|J1_|T3CODE_|T3_|VITE_|NODE_CHANNEL_|NODE_UNIQUE_ID$|NODE_OPTIONS$|WATCH_REPORT_DEPENDENCIES$)/i.test(
          key,
        ),
    ),
  );
}
