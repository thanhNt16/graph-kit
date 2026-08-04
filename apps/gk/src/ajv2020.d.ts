declare module "ajv/dist/2020.js" {
  import type { ValidateFunction } from "ajv";

  class Ajv2020 {
    constructor(opts?: unknown);
    compile(schema: unknown): ValidateFunction;
    errors?: unknown;
  }
  export default Ajv2020;
}
