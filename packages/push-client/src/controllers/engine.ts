import { RELAYER_EVENTS, RELAYER_DEFAULT_PROTOCOL } from "@walletconnect/core";
import {
  formatJsonRpcRequest,
  formatJsonRpcResult,
  formatJsonRpcError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcResult,
  isJsonRpcError,
} from "@walletconnect/jsonrpc-utils";
import { RelayerTypes } from "@walletconnect/types";
import { getInternalError, hashKey } from "@walletconnect/utils";

import { ENGINE_RPC_OPTS } from "../constants";
import { IPushEngine, JsonRpcTypes } from "../types";

// @ts-expect-error - `IPushEngine` not yet fully implemented.
export class PushEngine extends IPushEngine {
  private initialized = false;
  public name = "pushEngine";

  constructor(client: IPushEngine["client"]) {
    super(client);
  }

  public init: IPushEngine["init"] = () => {
    if (!this.initialized) {
      this.registerRelayerEvents();
      this.client.core.pairing.register({
        methods: Object.keys(ENGINE_RPC_OPTS),
      });
      this.initialized = true;
    }
  };

  // ---------- Public (Dapp) ----------------------------------------- //

  public request: IPushEngine["request"] = async ({
    account,
    pairingTopic,
  }) => {
    this.isInitialized();

    // SPEC: Dapp generates public key X
    const publicKey = await this.client.core.crypto.generateKeyPair();

    // SPEC: Dapp sends push proposal on known pairing P
    const payload = {
      publicKey,
      account,
      metadata: this.client.metadata,
    };
    const id = await this.sendRequest(pairingTopic, "wc_pushRequest", payload);

    // Store the push subscription request so we can later reference `publicKey` when we get a response.
    await this.client.requests.set(id, {
      topic: pairingTopic,
      payload,
    });

    return { id };
  };

  // ---------- Public (Wallet) --------------------------------------- //

  public approve: IPushEngine["approve"] = async ({ id }) => {
    this.isInitialized();

    const { topic: pairingTopic, payload } = this.client.requests.get(id);

    // SPEC: Wallet generates key pair Y
    const selfPublicKey = await this.client.core.crypto.generateKeyPair();

    this.client.logger.info(
      "[Push] Engine.approve > generating shared key from selfPublicKey %s and proposer publicKey %s",
      selfPublicKey,
      payload.params.publicKey
    );

    // SPEC: Wallet derives symmetric key from keys X and Y
    const symKeyTopic = await this.client.core.crypto.generateSharedKey(
      selfPublicKey,
      payload.params.publicKey
    );
    const symKey = this.client.core.crypto.keychain.get(symKeyTopic);

    // SPEC: Push topic is derived from sha256 hash of symmetric key
    const pushTopic = hashKey(symKey);

    this.client.logger.info(
      "[Push] Engine.approve > derived pushTopic: %s",
      pushTopic
    );

    // SPEC: Wallet subscribes to push topic
    await this.client.core.relayer.subscribe(pushTopic);

    // SPEC: Wallet sends proposal response on pairing P with publicKey Y
    await this.sendResult<"wc_pushRequest">(id, pairingTopic, {
      publicKey: selfPublicKey,
    });

    // Store the new PushSubscription.
    await this.client.subscriptions.set(pushTopic, {
      topic: pushTopic,
      relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
      metadata: payload.params.metadata,
    });

    // Clean up the original request.
    await this.client.requests.delete(id, {
      code: -1,
      message: "Cleaning up approved request.",
    });
  };

  // ---------- Public (Common) --------------------------------------- //

  // ---------- Private Helpers --------------------------------------- //

  protected setExpiry: IPushEngine["setExpiry"] = async (topic, expiry) => {
    if (this.client.core.pairing.pairings.keys.includes(topic)) {
      await this.client.core.pairing.updateExpiry({ topic, expiry });
    }
    this.client.core.expirer.set(topic, expiry);
  };

  protected sendRequest: IPushEngine["sendRequest"] = async (
    topic,
    method,
    params,
    encodeOpts
  ) => {
    const payload = formatJsonRpcRequest(method, params);
    const message = await this.client.core.crypto.encode(
      topic,
      payload,
      encodeOpts
    );
    const rpcOpts = ENGINE_RPC_OPTS[method].req;
    this.client.core.history.set(topic, payload);
    await this.client.core.relayer.publish(topic, message, rpcOpts);

    return payload.id;
  };

  protected sendResult: IPushEngine["sendResult"] = async (
    id,
    topic,
    result,
    encodeOpts
  ) => {
    const payload = formatJsonRpcResult(id, result);
    const message = await this.client.core.crypto.encode(
      topic,
      payload,
      encodeOpts
    );
    const record = await this.client.core.history.get(topic, id);
    const rpcOpts = ENGINE_RPC_OPTS[record.request.method].res;

    await this.client.core.relayer.publish(topic, message, rpcOpts);
    await this.client.core.history.resolve(payload);

    return payload.id;
  };

  protected sendError: IPushEngine["sendError"] = async (
    id,
    topic,
    params,
    encodeOpts
  ) => {
    const payload = formatJsonRpcError(id, params);
    const message = await this.client.core.crypto.encode(
      topic,
      payload,
      encodeOpts
    );
    const record = await this.client.core.history.get(topic, id);
    const rpcOpts = ENGINE_RPC_OPTS[record.request.method].res;

    await this.client.core.relayer.publish(topic, message, rpcOpts);
    await this.client.core.history.resolve(payload);

    return payload.id;
  };

  private isInitialized() {
    if (!this.initialized) {
      const { message } = getInternalError("NOT_INITIALIZED", this.name);
      throw new Error(message);
    }
  }

  // ---------- Relay Events Router ----------------------------------- //

  private registerRelayerEvents() {
    this.client.core.relayer.on(
      RELAYER_EVENTS.message,
      async (event: RelayerTypes.MessageEvent) => {
        const { topic, message } = event;
        const payload = await this.client.core.crypto.decode(topic, message);

        if (isJsonRpcRequest(payload)) {
          this.client.core.history.set(topic, payload);
          this.onRelayEventRequest({ topic, payload });
        } else if (isJsonRpcResponse(payload)) {
          await this.client.core.history.resolve(payload);
          this.onRelayEventResponse({ topic, payload });
        }
      }
    );
  }

  protected onRelayEventRequest: IPushEngine["onRelayEventRequest"] = (
    event
  ) => {
    const { topic, payload } = event;
    const reqMethod = payload.method as JsonRpcTypes.WcMethod;

    switch (reqMethod) {
      case "wc_pushRequest":
        return this.onPushRequest(topic, payload);
      case "wc_pushMessage":
        // TODO: implement `onPushMessageRequest` handler.
        return;
      default:
        return this.client.logger.info(
          `Unsupported request method ${reqMethod}`
        );
    }
  };

  protected onRelayEventResponse: IPushEngine["onRelayEventResponse"] = async (
    event
  ) => {
    const { topic, payload } = event;
    const record = await this.client.core.history.get(topic, payload.id);
    const resMethod = record.request.method as JsonRpcTypes.WcMethod;

    switch (resMethod) {
      case "wc_pushRequest":
        return this.onPushResponse(topic, payload);
      case "wc_pushMessage":
        // TODO: implement `onPushMessageResponse` handler.
        return;
      default:
        return this.client.logger.info(
          `Unsupported response method ${resMethod}`
        );
    }
  };

  // ---------- Relay Event Handlers --------------------------------- //

  protected onPushRequest: IPushEngine["onPushRequest"] = async (
    topic,
    payload
  ) => {
    this.client.logger.info("onPushRequest:", topic, payload);

    try {
      // Store the push subscription request so we can reference later for a response.
      await this.client.requests.set(payload.id, {
        topic,
        payload,
      });

      this.client.emit("push_request", {
        id: payload.id,
        topic,
        params: {
          id: payload.id,
          metadata: payload.params.metadata,
        },
      });
    } catch (err: any) {
      await this.sendError(payload.id, topic, err);
      this.client.logger.error(err);
    }
  };

  protected onPushResponse: IPushEngine["onPushResponse"] = async (
    topic,
    response
  ) => {
    this.client.logger.info("onPushResponse", topic, response);

    if (isJsonRpcResult(response)) {
      const { id, result } = response;

      const { payload } = this.client.requests.get(id);
      const selfPublicKey = payload.publicKey;

      this.client.logger.info(
        "[Push] Engine.onPushResponse > generating shared key from selfPublicKey %s and responder publicKey %s",
        selfPublicKey,
        result.publicKey
      );

      const symKeyTopic = await this.client.core.crypto.generateSharedKey(
        selfPublicKey,
        result.publicKey
      );
      const symKey = this.client.core.crypto.keychain.get(symKeyTopic);

      // SPEC: Push topic is derived from sha256 hash of symmetric key
      const pushTopic = hashKey(symKey);

      this.client.logger.info(
        "[Push] Engine.onPushResponse > derived pushTopic: %s",
        pushTopic
      );

      // (?) DappClient subscribes to pushTopic. Is this needed/missing in spec?
      // await this.client.core.relayer.subscribe(pushTopic);

      // Store the new PushSubscription.
      await this.client.subscriptions.set(pushTopic, {
        topic: pushTopic,
        relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
      });

      // Clean up the original request.
      await this.client.requests.delete(id, {
        code: -1,
        message: "Cleaning up approved request.",
      });

      this.client.emit("push_response", {
        id,
        topic,
        params: response,
      });
    } else if (isJsonRpcError(response)) {
      this.client.emit("push_response", {
        id: response.id,
        topic,
        params: response,
      });
    }
  };
}
