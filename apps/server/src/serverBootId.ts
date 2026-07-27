import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

const processServerBootId = `${process.pid}-${performance.timeOrigin}`;

/** One opaque identity shared by all process-owned runtime bindings and deliveries. */
export class ServerBootIdentity extends Context.Service<
  ServerBootIdentity,
  { readonly id: string }
>()("t3/serverBootId/ServerBootIdentity") {
  static readonly layer = Layer.succeed(
    ServerBootIdentity,
    ServerBootIdentity.of({ id: processServerBootId }),
  );
}
