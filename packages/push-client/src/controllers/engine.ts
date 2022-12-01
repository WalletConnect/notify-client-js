import { RELAYER_EVENTS } from "@walletconnect/core";
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
import { getInternalError } from "@walletconnect/utils";

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

  public request: IPushEngine["request"] = async (params) => {
    return Promise.resolve({ id: "mockId" });
  };

  // ---------- Public (Wallet) --------------------------------------- //

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
    this.client.logger.debug("onPushRequest:", topic, payload);

    try {
      // TODO: handle incoming push request

      this.client.emit("push_request", {
        id: payload.id,
        topic,
        params: {
          // TODO:
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
    const { id } = response;

    this.client.logger.debug("onPushResponse", topic, response);

    if (isJsonRpcResult(response)) {
      this.client.emit("push_response", { id, topic, params: response });
    } else if (isJsonRpcError(response)) {
      this.client.emit("push_response", { id, topic, params: response });
    }
  };
}
