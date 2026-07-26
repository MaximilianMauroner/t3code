import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** One opaque identity shared by all process-owned runtime bindings and deliveries. */
export class ServerBootIdentity extends Context.Service<
  ServerBootIdentity,
  { readonly id: string }
>()("t3/server/ServerBootIdentity") {
  static readonly layer = Layer.effect(
    ServerBootIdentity,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      return ServerBootIdentity.of({ id: yield* crypto.randomUUIDv4 });
    }),
  );
}
