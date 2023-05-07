import {
  EXPIRER_EVENTS,
  RELAYER_DEFAULT_PROTOCOL,
  RELAYER_EVENTS,
} from "@walletconnect/core";
import {
  JwtPayload,
  composeDidPkh,
  encodeEd25519Key,
  jwtExp,
} from "@walletconnect/did-jwt";
import {
  JsonRpcPayload,
  formatJsonRpcError,
  formatJsonRpcRequest,
  formatJsonRpcResult,
  isJsonRpcError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcResult,
} from "@walletconnect/jsonrpc-utils";
import { ExpirerTypes, RelayerTypes } from "@walletconnect/types";
import {
  TYPE_1,
  calcExpiry,
  getInternalError,
  hashKey,
  parseExpirerTarget,
} from "@walletconnect/utils";
import jwt from "jsonwebtoken";
import axios from "axios";

import {
  DEFAULT_RELAY_SERVER_URL,
  ENGINE_RPC_OPTS,
  PUSH_REQUEST_EXPIRY,
  PUSH_SUBSCRIPTION_EXPIRY,
  SDK_ERRORS,
} from "../constants";
import {
  IDappClient,
  IPushEngine,
  IWalletClient,
  JsonRpcTypes,
  PushClientTypes,
} from "../types";

export class PushEngine extends IPushEngine {
  public name = "pushEngine";
  private initialized = false;

  constructor(client: IPushEngine["client"]) {
    super(client);
  }

  public init: IPushEngine["init"] = () => {
    if (!this.initialized) {
      this.registerRelayerEvents();
      this.registerExpirerEvents();
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
    const responseTopic = hashKey(publicKey);

    // SPEC: Dapp sends push proposal on known pairing P
    const request = {
      publicKey,
      account,
      metadata: (this.client as IDappClient).metadata,
    };
    const id = await this.sendRequest(pairingTopic, "wc_pushRequest", request);

    this.client.logger.info(
      `[Push] Engine.request > sent push subscription request on pairing ${pairingTopic} with id: ${id}. Request: ${JSON.stringify(
        request
      )}`
    );

    // Store the push subscription request so we can later reference `publicKey` when we get a response.
    // TODO: Is this obsolete now?
    await this.client.requests.set(id, {
      topic: pairingTopic,
      request: {
        ...request,
        scope: {},
      },
    });

    await (this.client as IDappClient).proposalKeys.set(responseTopic, {
      responseTopic,
      proposalKeyPub: publicKey,
    });

    // Set the expiry for the push subscription request.
    this.client.core.expirer.set(id, calcExpiry(PUSH_REQUEST_EXPIRY));

    // SPEC: Dapp subscribes to response topic, which is the sha256 hash of public key X
    await this.client.core.relayer.subscribe(responseTopic);

    this.client.logger.info(
      `[Push] Engine.request > subscribed to response topic ${responseTopic}`
    );

    return { id };
  };

  public notify: IPushEngine["notify"] = async ({ topic, message }) => {
    this.isInitialized();

    this.client.logger.info(
      `[Push] Engine.notify > sending push notification on pairing ${topic} with message: "${message}"`
    );

    await this.sendRequest(topic, "wc_pushMessage", message);
  };

  // ---------- Public (Wallet) --------------------------------------- //

  public approve: IPushEngine["approve"] = async ({ id, onSign }) => {
    this.isInitialized();

    const { request } = this.client.requests.get(id);

    // Retrieve existing identity or register a new one for this account on this device.
    await this.registerIdentity(request.account, onSign);

    const dappUrl = request.metadata.url;
    const issuedAt = Math.round(Date.now() / 1000);
    const payload: JwtPayload = {
      iat: issuedAt,
      exp: jwtExp(issuedAt),
      iss: encodeEd25519Key(request.publicKey),
      sub: composeDidPkh(request.account),
      aud: dappUrl,
      ksu: (this.client as IWalletClient).keyserverUrl,
      scp: "",
      act: "push_subscription",
    };

    const subscriptionAuth = await this.generateSubscriptionAuth(
      request.account,
      payload
    );

    this.client.logger.debug(
      `[Push] Engine.approve > generated subscriptionAuth: ${subscriptionAuth}`
    );

    // SPEC: Wallet generates key pair Y
    const selfPublicKey = await this.client.core.crypto.generateKeyPair();

    this.client.logger.info(
      `[Push] Engine.approve > generating shared key from selfPublicKey ${selfPublicKey} and proposer publicKey ${request.publicKey}`
    );

    // SPEC: Wallet derives symmetric key from self-generated publicKey (pubKey Y) and requester publicKey (pubKey X).
    // SPEC: Push topic is derived from sha256 hash of symmetric key.
    // `crypto.generateSharedKey` returns the sha256 hash of the symmetric key, i.e. the push topic.
    const pushTopic = await this.client.core.crypto.generateSharedKey(
      selfPublicKey,
      request.publicKey
    );

    this.client.logger.info(
      `[Push] Engine.approve > derived pushTopic: ${pushTopic}`
    );

    // SPEC: Wallet subscribes to push topic
    await this.client.core.relayer.subscribe(pushTopic);

    // SPEC: Wallet derives response topic from sha246 hash of requester publicKey (pubKey X)
    const responseTopic = hashKey(request.publicKey);

    this.client.logger.info(
      `[Push] Engine.approve > derived responseTopic: ${responseTopic}`
    );

    // SPEC: Wallet sends proposal response on pairing P with publicKey Y
    await this.sendResult<"wc_pushRequest">(
      id,
      responseTopic,
      {
        subscriptionAuth,
      },
      {
        type: TYPE_1,
        senderPublicKey: selfPublicKey,
        receiverPublicKey: request.publicKey,
      }
    );

    // Store the new PushSubscription.
    await this.client.subscriptions.set(pushTopic, {
      topic: pushTopic,
      account: request.account,
      relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
      metadata: request.metadata,
      scope: {},
      expiry: PUSH_SUBSCRIPTION_EXPIRY,
    });

    // Set up a store for messages sent to this push topic.
    await (this.client as IWalletClient).messages.set(pushTopic, {
      topic: pushTopic,
      messages: {},
    });

    // Clean up the original request.
    this.cleanupRequest(id);

    // Clean up the keypair used to derive a shared symKey.
    await this.client.core.crypto.deleteKeyPair(selfPublicKey);
  };

  public reject: IPushEngine["reject"] = async ({ id, reason }) => {
    this.isInitialized();

    const { topic: pairingTopic } = this.client.requests.get(id);

    // SPEC: Wallet sends error response (i.e. proposal rejection) on pairing P
    await this.sendError(id, pairingTopic, {
      code: SDK_ERRORS["USER_REJECTED"].code,
      message: `${SDK_ERRORS["USER_REJECTED"].message} Reason: ${reason}.`,
    });

    this.client.logger.info(
      `[Push] Engine.reject > rejected push subscription request on pairing topic ${pairingTopic}`
    );

    // Clean up the original request.
    this.cleanupRequest(id);
  };

  public subscribe: IPushEngine["subscribe"] = async ({
    metadata,
    account,
    onSign,
  }) => {
    this.isInitialized();

    let didDoc: PushClientTypes.PushDidDocument;
    let pushConfig: PushClientTypes.PushConfigDocument;

    try {
      // Fetch dapp's public key from its hosted DID doc.
      const didDocResp = await axios.get(
        `${metadata.url}/.well-known/did.json`
      );
      didDoc = didDocResp.data;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch dapp's DID doc from ${metadata.url}/.well-known/did.json. Error: ${error.message}`
      );
    }

    try {
      // Fetch dapp's Push config from its hosted wc-push-config.
      const pushConfigResp = await axios.get(
        `${metadata.url}/.well-known/wc-push-config.json`
      );
      pushConfig = pushConfigResp.data;

      this.client.logger.info(
        `[Push] subscribe > got push config: ${JSON.stringify(pushConfig)}`
      );
    } catch (error: any) {
      throw new Error(
        `Failed to fetch dapp's Push config from ${metadata.url}/.well-known/wc-push-config.json. Error: ${error.message}`
      );
    }

    // Retrieve existing identity or register a new one for this account on this device.
    await this.registerIdentity(account, onSign);

    const { publicKeyJwk } = didDoc.verificationMethod[0];
    const base64Jwk = publicKeyJwk.x.replace(/-/g, "+").replace(/_/g, "/");
    const dappPublicKey = Buffer.from(base64Jwk, "base64").toString("hex");

    this.client.logger.info(
      `[Push] subscribe > publicKey for ${metadata.url} is: ${dappPublicKey}`
    );

    // SPEC: Wallet derives subscribe topic, which is the sha256 hash of public key X
    const subscribeTopic = hashKey(dappPublicKey);

    // SPEC: Wallet generates key pair Y
    const selfPublicKey = await this.client.core.crypto.generateKeyPair();

    // SPEC: Wallet derives S symmetric key with keys X and Y
    const responseTopic = await this.client.core.crypto.generateSharedKey(
      selfPublicKey,
      dappPublicKey
    );

    // SPEC: Generate a subscriptionAuth JWT
    const dappUrl = metadata.url;
    const issuedAt = Math.round(Date.now() / 1000);
    const scp = pushConfig.types.map((type) => type.name).join(" ");
    const payload: JwtPayload = {
      iat: issuedAt,
      exp: jwtExp(issuedAt),
      iss: encodeEd25519Key(dappPublicKey),
      sub: composeDidPkh(account),
      aud: dappUrl,
      ksu: (this.client as IWalletClient).keyserverUrl,
      scp,
      act: "push_subscription",
    };

    this.client.logger.info(
      `[Push] subscribe > generating subscriptionAuth JWT for payload: ${JSON.stringify(
        payload
      )}`
    );

    const subscriptionAuth = await this.generateSubscriptionAuth(
      account,
      payload
    );

    this.client.logger.info(
      `[Push] subscribe > generated subscriptionAuth JWT: ${subscriptionAuth}`
    );

    // SPEC: Wallet subscribes to response topic
    await this.client.core.relayer.subscribe(responseTopic);

    this.client.logger.info(
      `[Push] subscribe > subscribed to responseTopic ${responseTopic}`
    );

    this.client.logger.info(
      `[Push] subscribe > sending wc_pushSubscribe request on topic ${subscribeTopic}...`
    );

    // SPEC: Wallet sends wc_pushSubscribe request (type 1 envelope) on subscribe topic with subscriptionAuth
    const id = await this.sendRequest<"wc_pushSubscribe">(
      subscribeTopic,
      "wc_pushSubscribe",
      {
        subscriptionAuth,
      },
      {
        type: TYPE_1,
        senderPublicKey: selfPublicKey,
        receiverPublicKey: dappPublicKey,
      }
    );

    this.client.logger.info({
      action: "sendRequest",
      method: "wc_pushSubscribe",
      id,
      topic: subscribeTopic,
      subscriptionAuth,
      params: {
        type: TYPE_1,
        senderPublicKey: selfPublicKey,
        receiverPublicKey: dappPublicKey,
      },
    });

    const scopeMap: PushClientTypes.ScopeMap = pushConfig.types.reduce(
      (map, type) => {
        map[type.name] = { description: type.description, enabled: true };
        return map;
      },
      {}
    );

    // Store the pending subscription request.
    this.client.requests.set(id, {
      topic: responseTopic,
      request: {
        account,
        metadata,
        publicKey: selfPublicKey,
        scope: scopeMap,
      },
    });

    // Set the expiry for the push subscription request.
    this.client.core.expirer.set(id, calcExpiry(PUSH_REQUEST_EXPIRY));

    return true;
  };

  public decryptMessage: IPushEngine["decryptMessage"] = async ({
    topic,
    encryptedMessage,
  }) => {
    this.isInitialized();

    const payload: JsonRpcPayload<
      JsonRpcTypes.RequestParams["wc_pushMessage"]
    > = await this.client.core.crypto.decode(topic, encryptedMessage);

    if (!("params" in payload)) {
      throw new Error(
        "Invalid message payload provided to `decryptMessage`: expected `params` key to be present."
      );
    }

    return payload.params;
  };

  public getMessageHistory: IPushEngine["getMessageHistory"] = ({ topic }) => {
    this.isInitialized();

    return (this.client as IWalletClient).messages.get(topic).messages;
  };

  public deletePushMessage: IPushEngine["deletePushMessage"] = ({ id }) => {
    this.isInitialized();

    const targetRecord = (this.client as IWalletClient).messages
      .getAll()
      .find((record) => record.messages[id]);

    if (!targetRecord) {
      throw new Error(
        `No message with id ${id} found in push message history.`
      );
    }

    delete targetRecord.messages[id];

    (this.client as IWalletClient).messages.update(
      targetRecord.topic,
      targetRecord
    );
  };

  // ---------- Public (Common) --------------------------------------- //

  public getActiveSubscriptions: IPushEngine["getActiveSubscriptions"] = () => {
    this.isInitialized();

    return Object.fromEntries(this.client.subscriptions.map);
  };

  public deleteSubscription: IPushEngine["deleteSubscription"] = async ({
    topic,
  }) => {
    this.isInitialized();

    await this.sendRequest(
      topic,
      "wc_pushDelete",
      SDK_ERRORS["USER_UNSUBSCRIBED"]
    );
    await this.cleanupSubscription(topic);

    this.client.logger.info(
      `[Push] Engine.delete > deleted push subscription on topic ${topic}`
    );
  };

  // ---------- Protected Helpers --------------------------------------- //

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
    this.client.core.relayer.publish(topic, message, rpcOpts);

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

    this.client.core.relayer.publish(topic, message, rpcOpts);
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

  // ---------- Relay Events Router ----------------------------------- //

  private registerRelayerEvents() {
    this.client.core.relayer.on(
      RELAYER_EVENTS.message,
      async (event: RelayerTypes.MessageEvent) => {
        const { topic, message, publishedAt } = event;
        const isType1Payload =
          this.client.core.crypto.getPayloadType(message) === TYPE_1;

        let receiverPublicKey: string | undefined;

        if (
          this.client instanceof IDappClient &&
          this.client.proposalKeys.keys.includes(topic)
        ) {
          try {
            const { proposalKeyPub } = this.client.proposalKeys.get(topic);
            receiverPublicKey = proposalKeyPub;
          } catch (error) {
            this.client.logger.error(
              `[Push] Engine > on RELAYER_EVENTS.message > Failed to get proposalKey for topic ${topic}: ${error}`
            );
          }
        }

        if (isType1Payload && !receiverPublicKey) {
          this.client.logger.debug(
            `[Push] Engine > on RELAYER_EVENTS.message > Skipping message on topic ${topic}, no receiverPublicKey found.`
          );
          return;
        }

        const payload = await this.client.core.crypto.decode(topic, message, {
          receiverPublicKey,
        });

        // Extract the encoded `senderPublicKey` if it's a TYPE_1 message.
        const senderPublicKey = isType1Payload
          ? this.client.core.crypto.getPayloadSenderPublicKey(message)
          : undefined;

        if (isJsonRpcRequest(payload)) {
          this.client.core.history.set(topic, payload);
          this.onRelayEventRequest({
            topic,
            payload,
            publishedAt,
            senderPublicKey,
          });
        } else if (isJsonRpcResponse(payload)) {
          await this.client.core.history.resolve(payload);
          this.onRelayEventResponse({
            topic,
            payload,
            publishedAt,
            senderPublicKey,
          });
        }
      }
    );
  }

  protected onRelayEventRequest: IPushEngine["onRelayEventRequest"] = (
    event
  ) => {
    const { topic, payload, publishedAt } = event;
    const reqMethod = payload.method as JsonRpcTypes.WcMethod;

    switch (reqMethod) {
      case "wc_pushRequest":
        return this.onPushRequest(topic, payload);
      case "wc_pushMessage":
        // `wc_pushMessage` requests being broadcast to all subscribers
        // by Cast server should only be handled by the wallet client.
        return this.client instanceof IWalletClient
          ? this.onPushMessageRequest(topic, payload, publishedAt)
          : null;
      case "wc_pushDelete":
        return this.onPushDeleteRequest(topic, payload);
      default:
        return this.client.logger.info(
          `[Push] Unsupported request method ${reqMethod}`
        );
    }
  };

  protected onRelayEventResponse: IPushEngine["onRelayEventResponse"] = async (
    event
  ) => {
    const { topic, payload, senderPublicKey } = event;
    const record = await this.client.core.history.get(topic, payload.id);
    const resMethod = record.request.method as JsonRpcTypes.WcMethod;

    switch (resMethod) {
      case "wc_pushRequest":
        return this.onPushResponse(topic, payload, senderPublicKey);
      case "wc_pushSubscribe":
        return this.onPushSubscribeResponse(topic, payload);
      case "wc_pushMessage":
        return this.onPushMessageResponse(topic, payload);
      case "wc_pushDelete":
        return;
      default:
        return this.client.logger.info(
          `[Push] Unsupported response method ${resMethod}`
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
        request: {
          ...payload.params,
          scope: {},
        },
      });

      // Set the expiry for the push subscription request.
      this.client.core.expirer.set(payload.id, calcExpiry(PUSH_REQUEST_EXPIRY));

      this.client.emit("push_request", {
        id: payload.id,
        topic,
        params: {
          id: payload.id,
          account: payload.params.account,
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
    response,
    senderPublicKey
  ) => {
    this.client.logger.info("onPushResponse", topic, response);

    if (isJsonRpcResult(response)) {
      const { id, result } = response;

      const { request } = this.client.requests.get(id);
      const selfPublicKey = request.publicKey;

      const decodedPayload = jwt.decode(result.subscriptionAuth, {
        json: true,
      }) as JwtPayload;

      if (!decodedPayload) {
        throw new Error(
          "[Push] Engine.onPushResponse > Empty `subscriptionAuth` payload"
        );
      }

      this.client.logger.info(
        `[Push] Engine.onPushResponse > decoded subscriptionAuth payload: ${JSON.stringify(
          decodedPayload
        )}`
      );

      if (!senderPublicKey) {
        throw new Error(
          "[Push] Engine.onPushResponse > Missing `senderPublicKey`, cannot derive shared key."
        );
      }

      // SPEC: Wallet derives symmetric key from keys X and Y.
      // SPEC: Push topic is derived from sha256 hash of symmetric key.
      // `crypto.generateSharedKey` returns the sha256 hash of the symmetric key, i.e. the push topic.
      const pushTopic = await this.client.core.crypto.generateSharedKey(
        selfPublicKey,
        senderPublicKey
      );
      const symKey = this.client.core.crypto.keychain.get(pushTopic);

      this.client.logger.info(
        `[Push] Engine.onPushResponse > derived pushTopic ${pushTopic} from symKey: ${symKey}`
      );

      // SPEC: Dapp registers address with the Cast Server.
      await this.registerOnCastServer(
        request.account,
        symKey,
        result.subscriptionAuth
      );

      // DappClient subscribes to pushTopic.
      await this.client.core.relayer.subscribe(pushTopic);

      const pushSubscription = {
        topic: pushTopic,
        account: request.account,
        relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
        metadata: request.metadata,
        scope: {},
        expiry: PUSH_SUBSCRIPTION_EXPIRY,
      };

      // Store the new PushSubscription.
      await this.client.subscriptions.set(pushTopic, pushSubscription);

      // Clean up the keypair used to derive a shared symKey.
      await this.client.core.crypto.deleteKeyPair(selfPublicKey);

      // Clean up the proposal key.
      await (this.client as IDappClient).proposalKeys.delete(topic, {
        code: -1,
        message: "Proposal key deleted.",
      });

      // Emit the PushSubscription at client level.
      this.client.emit("push_response", {
        id: response.id,
        topic,
        params: {
          subscription: pushSubscription,
        },
      });
    } else if (isJsonRpcError(response)) {
      // Emit the error response at client level.
      this.client.emit("push_response", {
        id: response.id,
        topic,
        params: {
          error: response.error,
        },
      });
    }

    // Clean up the original request regardless of concrete result.
    this.cleanupRequest(response.id);
  };

  protected onPushSubscribeResponse: IPushEngine["onPushSubscribeResponse"] =
    async (responseTopic, response) => {
      this.client.logger.info(
        `onPushSubscribeResponse on response topic ${responseTopic}`
      );

      if (isJsonRpcResult(response)) {
        const { id } = response;

        this.client.logger.info({
          event: "onPushSubscribeResponse",
          id,
          topic: responseTopic,
          response,
        });

        const { request } = this.client.requests.get(id);

        // SPEC: Wallet derives symmetric key P with keys Y and Z.
        // SPEC: Push topic is derived from the sha256 hash of the symmetric key P
        const pushTopic = await this.client.core.crypto.generateSharedKey(
          request.publicKey,
          response.result.publicKey
        );

        this.client.logger.info(
          `onPushSubscribeResponse > derived pushTopic ${pushTopic} from selfPublicKey ${request.publicKey} and Cast publicKey ${response.result.publicKey}`
        );

        const pushSubscription = {
          topic: pushTopic,
          account: request.account,
          relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
          metadata: request.metadata,
          scope: request.scope,
          expiry: PUSH_SUBSCRIPTION_EXPIRY,
        };

        // Store the new PushSubscription.
        await this.client.subscriptions.set(pushTopic, pushSubscription);

        // Set up a store for messages sent to this push topic.
        await (this.client as IWalletClient).messages.set(pushTopic, {
          topic: pushTopic,
          messages: {},
        });

        await this.cleanupRequest(id);

        // Emit the PushSubscription at client level.
        this.client.emit("push_subscription", {
          id: response.id,
          topic: pushTopic,
          params: {
            subscription: pushSubscription,
          },
        });
      } else if (isJsonRpcError(response)) {
        // Emit the error response at client level.
        this.client.emit("push_subscription", {
          id: response.id,
          topic: responseTopic,
          params: {
            error: response.error,
          },
        });
      }

      // Clean up the original request regardless of concrete result.
      this.cleanupRequest(response.id, true);
    };

  protected onPushMessageRequest: IPushEngine["onPushMessageRequest"] = async (
    topic,
    payload,
    publishedAt
  ) => {
    this.client.logger.info(
      "[Push] Engine.onPushMessageRequest",
      topic,
      payload
    );

    const currentMessages = (this.client as IWalletClient).messages.get(
      topic
    ).messages;
    await (this.client as IWalletClient).messages.update(topic, {
      messages: {
        ...currentMessages,
        [payload.id]: {
          id: payload.id,
          topic,
          message: payload.params,
          publishedAt,
        },
      },
    });
    await this.sendResult<"wc_pushMessage">(payload.id, topic, true);
    this.client.emit("push_message", {
      id: payload.id,
      topic,
      params: { message: payload.params },
    });
  };

  protected onPushMessageResponse: IPushEngine["onPushMessageResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Push] Engine.onPushMessageResponse > result:",
          topic,
          payload
        );
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Push] Engine.onPushMessageResponse > error:",
          topic,
          payload.error
        );
      }
    };

  protected onPushDeleteRequest: IPushEngine["onPushDeleteRequest"] = async (
    topic,
    payload
  ) => {
    const { id } = payload;
    try {
      await this.sendResult<"wc_pushDelete">(id, topic, true);
      await this.cleanupSubscription(topic);
      this.client.events.emit("push_delete", { id, topic });
    } catch (err: any) {
      await this.sendError(id, topic, err);
      this.client.logger.error(err);
    }
  };

  // ---------- Expirer Events ---------------------------------------- //

  private registerExpirerEvents() {
    this.client.core.expirer.on(
      EXPIRER_EVENTS.expired,
      async (event: ExpirerTypes.Expiration) => {
        this.client.logger.info(
          `[Push] EXPIRER_EVENTS.expired > target: ${event.target}, expiry: ${event.expiry}`
        );

        const { id } = parseExpirerTarget(event.target);

        if (id) {
          await this.cleanupRequest(id, true);
          this.client.events.emit("request_expire", { id });
        }
      }
    );
  }

  // ---------- Private Helpers --------------------------------- //

  private isInitialized() {
    if (!this.initialized) {
      const { message } = getInternalError("NOT_INITIALIZED", this.name);
      throw new Error(message);
    }
  }

  private cleanupRequest = async (id: number, expirerHasDeleted?: boolean) => {
    await Promise.all([
      this.client.requests.delete(id, {
        code: -1,
        message: "Request deleted.",
      }),
      expirerHasDeleted ? Promise.resolve() : this.client.core.expirer.del(id),
    ]);
  };

  private cleanupSubscription = async (topic: string) => {
    // Await the unsubscribe first to avoid deleting the symKey too early below.
    await this.client.core.relayer.unsubscribe(topic);
    await Promise.all([
      this.client.subscriptions.delete(topic, {
        code: -1,
        message: "Deleted subscription.",
      }),
      this.client instanceof IWalletClient
        ? this.client.messages.delete(topic, {
            code: -1,
            message: "Deleted subscription.",
          })
        : Promise.resolve(),
      this.client.core.crypto.deleteSymKey(topic),
    ]);
  };

  private registerOnCastServer = async (
    account: string,
    symKey: string,
    subscriptionAuth: string
  ) => {
    const castUrl = (this.client as IDappClient).castUrl;
    const reqUrl = castUrl + `/${this.client.core.projectId}/register`;
    const relayUrl = this.client.core.relayUrl || DEFAULT_RELAY_SERVER_URL;
    const bodyString = JSON.stringify({
      account,
      symKey,
      subscriptionAuth,
      relayUrl,
    });
    try {
      this.client.logger.info(
        `[Push] Engine.onPushResponse > POST to Cast Server at ${reqUrl} with body ${bodyString}`
      );

      const res = await fetch(reqUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: bodyString,
      });

      this.client.logger.info(
        `[Push] Engine.onPushResponse > POST to Cast Server at ${reqUrl} returned ${res.status} - ${res.statusText}`
      );
    } catch (error: any) {
      this.client.logger.error(
        `[Push] Could not register push subscription on Cast Server via POST with body: ${bodyString} to ${reqUrl}: ${error.message}`
      );
    }
  };

  private generateSubscriptionAuth = async (
    accountId: string,
    payload: JwtPayload
  ) => {
    return (this.client as IWalletClient).identityKeys.generateIdAuth(
      accountId,
      payload
    );
  };

  private registerIdentity = async (
    accountId: string,
    onSign: (message: string) => Promise<string>
  ): Promise<string> => {
    return (this.client as IWalletClient).identityKeys.registerIdentity({
      accountId,
      onSign,
    });
  };
}
