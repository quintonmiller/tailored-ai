// Fixture plugin for the e2e plugin-install scenario.
//
// We don't import @tailored-ai/core here on purpose. The scenario verifies
// the install / list / remove flow of `tai plugin install` — i.e. that the
// plugin home is bootstrapped, the package lands in node_modules, and
// removal cleans up. Runtime side-effect registration is a separate concern
// and would require core to be resolvable from the plugin's location, which
// is a known limitation tracked alongside #45.
export const noop = true;
