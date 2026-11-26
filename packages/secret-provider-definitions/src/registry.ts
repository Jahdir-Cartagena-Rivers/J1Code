import { makeSecretProviderDefinitionRegistry } from "@j1code/secret-provider-core/shared/definition";
import * as OnePassword from "@j1code/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
