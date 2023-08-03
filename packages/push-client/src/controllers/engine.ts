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
import axios from "axios";

import {
  ENGINE_RPC_OPTS,
  JWT_SCP_SEPARATOR,
  NOTIFY_REQUEST_EXPIRY,
  NOTIFY_SUBSCRIPTION_EXPIRY,
  SDK_ERRORS,
} from "../constants";
import {
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

  // ---------- Public --------------------------------------- //

  public enableSync: IPushEngine["enableSync"] = async ({
    account,
    onSign,
  }) => {
    const client = (this.client as IWalletClient).syncClient;
    const signature = await onSign(await client.getMessage({ account }));
    await client.register({ account, signature });

    await (this.client as IWalletClient).initSyncStores({ account, signature });
  };

  public subscribe: IPushEngine["subscribe"] = async ({
    metadata,
    account,
    onSign,
  }) => {
    this.isInitialized();

    let didDoc: PushClientTypes.PushDidDocument;

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

    const pushConfig = await this.resolvePushConfig(metadata.url);

    // Retrieve existing identity or register a new one for this account on this device.
    await this.registerIdentity(account, onSign);

    const { publicKeyJwk } = didDoc.verificationMethod[0];
    const base64Jwk = publicKeyJwk.x.replace(/-/g, "+").replace(/_/g, "/");
    const dappPublicKey = Buffer.from(base64Jwk, "base64").toString("hex");

    this.client.logger.info(
      `[Notify] subscribe > publicKey for ${metadata.url} is: ${dappPublicKey}`
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
    const identityKeyPub = await (
      this.client as IWalletClient
    ).identityKeys.getIdentity({
      account,
    });
    const dappUrl = metadata.url;
    const issuedAt = Math.round(Date.now() / 1000);
    this.client;
    const scp = pushConfig.types
      .map((type) => type.name)
      .join(JWT_SCP_SEPARATOR);
    const payload: JwtPayload = {
      iat: issuedAt,
      exp: jwtExp(issuedAt),
      iss: encodeEd25519Key(identityKeyPub),
      sub: composeDidPkh(account),
      aud: dappUrl,
      ksu: (this.client as IWalletClient).keyserverUrl,
      scp,
      act: "notify_subscription",
    };

    this.client.logger.info(
      `[Notify] subscribe > generating subscriptionAuth JWT for payload: ${JSON.stringify(
        payload
      )}`
    );

    const subscriptionAuth = await this.generateSubscriptionAuth(
      account,
      payload
    );

    this.client.logger.info(
      `[Notify] subscribe > generated subscriptionAuth JWT: ${subscriptionAuth}`
    );

    // SPEC: Wallet subscribes to response topic
    await this.client.core.relayer.subscribe(responseTopic);

    this.client.logger.info(
      `[Notify] subscribe > subscribed to responseTopic ${responseTopic}`
    );

    this.client.logger.info(
      `[Notify] subscribe > sending wc_notifySubscribe request on topic ${subscribeTopic}...`
    );

    // SPEC: Wallet sends wc_notifySubscribe request (type 1 envelope) on subscribe topic with subscriptionAuth
    const id = await this.sendRequest<"wc_notifySubscribe">(
      subscribeTopic,
      "wc_notifySubscribe",
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
      method: "wc_notifySubscribe",
      id,
      topic: subscribeTopic,
      subscriptionAuth,
      params: {
        type: TYPE_1,
        senderPublicKey: selfPublicKey,
        receiverPublicKey: dappPublicKey,
      },
    });

    const scopeMap = this.generateScopeMapFromConfig(pushConfig.types);

    // Store the pending subscription request.
    (this.client as IWalletClient).requests.set(id, {
      topic: responseTopic,
      request: {
        account,
        metadata,
        publicKey: selfPublicKey,
        scope: scopeMap,
      },
    });

    // Set the expiry for the push subscription request.
    this.client.core.expirer.set(id, calcExpiry(NOTIFY_REQUEST_EXPIRY));

    return { id, subscriptionAuth };
  };

  public update: IPushEngine["update"] = async ({ topic, scope }) => {
    this.isInitialized();

    this.client.logger.info(
      `[Notify] update > updating push subscription for topic ${topic} with new scope: ${JSON.stringify(
        scope
      )}`
    );

    let subscription: PushClientTypes.PushSubscription;

    // Retrieves the known subscription for the given topic or throws if no subscription is found.
    try {
      subscription = this.client.subscriptions.get(topic);
    } catch (error) {
      throw new Error(
        `update(): No subscription found to update for the given topic: ${topic}`
      );
    }

    const identityKeyPub = await (
      this.client as IWalletClient
    ).identityKeys.getIdentity({
      account: subscription.account,
    });
    const issuedAt = Math.round(Date.now() / 1000);
    const payload: JwtPayload = {
      iat: issuedAt,
      exp: jwtExp(issuedAt),
      iss: encodeEd25519Key(identityKeyPub),
      sub: composeDidPkh(subscription.account),
      aud: subscription.metadata.url,
      ksu: (this.client as IWalletClient).keyserverUrl,
      scp: scope.join(JWT_SCP_SEPARATOR),
      act: "notify_subscription",
    };

    this.client.logger.info(
      `[Notify] update > generating subscriptionAuth JWT for payload: ${JSON.stringify(
        payload
      )}`
    );

    const subscriptionAuth = await this.generateSubscriptionAuth(
      subscription.account,
      payload
    );

    this.client.logger.info(
      `[Notify] update > generated subscriptionAuth JWT: ${subscriptionAuth}`
    );

    const id = await this.sendRequest(topic, "wc_notifyUpdate", {
      subscriptionAuth,
    });

    this.client.logger.info({
      action: "sendRequest",
      method: "wc_notifyUpdate",
      id,
      topic,
      subscriptionAuth,
    });

    await (this.client as IWalletClient).requests.set(id, {
      topic,
      request: {
        account: subscription.account,
        metadata: subscription.metadata,
        publicKey: identityKeyPub,
        scope: subscription.scope,
        scopeUpdate: scope,
      },
    });

    return true;
  };

  public decryptMessage: IPushEngine["decryptMessage"] = async ({
    topic,
    encryptedMessage,
  }) => {
    this.isInitialized();

    try {
      const payload: JsonRpcPayload<
        JsonRpcTypes.RequestParams["wc_notifyMessage"]
      > = await this.client.core.crypto.decode(topic, encryptedMessage);

      if (!("params" in payload)) {
        throw new Error(
          "Invalid message payload provided to `decryptMessage`: expected `params` key to be present."
        );
      }

      return payload.params;
    } catch (e) {
      this.client.logger.error(
        `Could not decode payload "${encryptedMessage}" on topic ${topic}`
      );
      throw new Error(
        `Could not decode payload "${encryptedMessage}" on topic ${topic}`
      );
    }
  };

  public getMessageHistory: IPushEngine["getMessageHistory"] = ({ topic }) => {
    this.isInitialized();

    return (this.client as IWalletClient).messages.get(topic).messages;
  };

  public deleteSubscription: IPushEngine["deleteSubscription"] = async ({
    topic,
  }) => {
    this.isInitialized();

    await this.sendRequest(
      topic,
      "wc_notifyDelete",
      SDK_ERRORS["USER_UNSUBSCRIBED"]
    );
    await this.cleanupSubscription(topic);

    this.client.logger.info(
      `[Notify] Engine.delete > deleted push subscription on topic ${topic}`
    );
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

  public getActiveSubscriptions: IPushEngine["getActiveSubscriptions"] = (
    params
  ) => {
    this.isInitialized();

    const subscriptions = this.client.subscriptions
      .getAll(params)
      .map((subscription) => [subscription.topic, subscription]);

    return Object.fromEntries(subscriptions);
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

        const payload = await this.client.core.crypto.decode(topic, message);

        if (isJsonRpcRequest(payload)) {
          this.client.core.history.set(topic, payload);
          this.onRelayEventRequest({
            topic,
            payload,
            publishedAt,
          });
        } else if (isJsonRpcResponse(payload)) {
          await this.client.core.history.resolve(payload);
          this.onRelayEventResponse({
            topic,
            payload,
            publishedAt,
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
      case "wc_notifyMessage":
        // `wc_notifyMessage` requests being broadcast to all subscribers
        // by Cast server should only be handled by the wallet client.
        return this.client instanceof IWalletClient
          ? this.onPushMessageRequest(topic, payload, publishedAt)
          : null;
      case "wc_notifyDelete":
        return this.onPushDeleteRequest(topic, payload);
      default:
        return this.client.logger.info(
          `[Notify] Unsupported request method ${reqMethod}`
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
      case "wc_notifySubscribe":
        return this.onPushSubscribeResponse(topic, payload);
      case "wc_notifyMessage":
        return this.onPushMessageResponse(topic, payload);
      case "wc_notifyDelete":
        return;
      case "wc_notifyUpdate":
        return this.onPushUpdateResponse(topic, payload);
      default:
        return this.client.logger.info(
          `[Notify] Unsupported response method ${resMethod}`
        );
    }
  };

  // ---------- Relay Event Handlers --------------------------------- //

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

        const { request } = (this.client as IWalletClient).requests.get(id);

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
          expiry: calcExpiry(NOTIFY_SUBSCRIPTION_EXPIRY),
          symKey: this.client.core.crypto.keychain.get(pushTopic),
        };

        // Store the new PushSubscription.
        await this.client.subscriptions.set(pushTopic, pushSubscription);

        // Set up a store for messages sent to this push topic.
        await (this.client as IWalletClient).messages.set(pushTopic, {
          topic: pushTopic,
          messages: {},
        });

        // SPEC: Wallet subscribes to derived pushTopic.
        await this.client.core.relayer.subscribe(pushTopic);

        // Wallet unsubscribes from response topic.
        await this.client.core.relayer.unsubscribe(responseTopic);

        // Emit the PushSubscription at client level.
        this.client.emit("notify_subscription", {
          id: response.id,
          topic: pushTopic,
          params: {
            subscription: pushSubscription,
          },
        });
      } else if (isJsonRpcError(response)) {
        // Emit the error response at client level.
        this.client.emit("notify_subscription", {
          id: response.id,
          topic: responseTopic,
          params: {
            error: response.error,
          },
        });
      }

      // Clean up the original request regardless of concrete result.
      this.cleanupRequest(response.id);
    };

  protected onPushMessageRequest: IPushEngine["onPushMessageRequest"] = async (
    topic,
    payload,
    publishedAt
  ) => {
    this.client.logger.info(
      "[Notify] Engine.onPushMessageRequest",
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
    await this.sendResult<"wc_notifyMessage">(payload.id, topic, true);
    this.client.emit("notify_message", {
      id: payload.id,
      topic,
      params: { message: payload.params },
    });
  };

  protected onPushMessageResponse: IPushEngine["onPushMessageResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Notify] Engine.onPushMessageResponse > result:",
          topic,
          payload
        );
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Notify] Engine.onPushMessageResponse > error:",
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
    this.client.logger.info(
      "[Notify] Engine.onPushDeleteRequest",
      topic,
      payload
    );
    try {
      await this.sendResult<"wc_notifyDelete">(id, topic, true);
      await this.cleanupSubscription(topic);
      this.client.events.emit("notify_delete", { id, topic });
    } catch (err: any) {
      this.client.logger.error(err);
      await this.sendError(id, topic, err);
    }
  };

  protected onPushUpdateResponse: IPushEngine["onPushUpdateResponse"] = async (
    topic,
    payload
  ) => {
    if (isJsonRpcResult(payload)) {
      this.client.logger.info({
        event: "onPushUpdateResponse",
        topic,
        result: payload,
      });

      const { id } = payload;

      const { request } = (this.client as IWalletClient).requests.get(id);
      const existingSubscription = this.client.subscriptions.get(topic);

      if (!request.scopeUpdate) {
        throw new Error(
          `No scope update found in request for push update: ${JSON.stringify(
            request
          )}`
        );
      }

      const updatedScope = Object.entries(existingSubscription.scope).reduce(
        (map, [scope, setting]) => {
          map[scope] = setting;
          if (request.scopeUpdate?.includes(scope)) {
            map[scope].enabled = true;
          } else {
            map[scope].enabled = false;
          }
          return map;
        },
        {} as PushClientTypes.PushSubscription["scope"]
      );

      const updatedSubscription: PushClientTypes.PushSubscription = {
        ...existingSubscription,
        scope: updatedScope,
        expiry: calcExpiry(NOTIFY_SUBSCRIPTION_EXPIRY),
      };

      await this.client.subscriptions.set(topic, updatedSubscription);

      this.client.events.emit("notify_update", {
        id,
        topic,
        params: {
          subscription: updatedSubscription,
        },
      });
    } else if (isJsonRpcError(payload)) {
      this.client.logger.error({
        event: "onPushUpdateResponse",
        topic,
        error: payload.error,
      });
      this.client.emit("notify_update", {
        id: payload.id,
        topic,
        params: {
          error: payload.error,
        },
      });
    }
  };

  // ---------- Expirer Events ---------------------------------------- //

  private registerExpirerEvents() {
    this.client.core.expirer.on(
      EXPIRER_EVENTS.expired,
      async (event: ExpirerTypes.Expiration) => {
        this.client.logger.info(
          `[Notify] EXPIRER_EVENTS.expired > target: ${event.target}, expiry: ${event.expiry}`
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
      (this.client as IWalletClient).requests.delete(id, {
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

  private resolvePushConfig = async (
    dappUrl: string
  ): Promise<PushClientTypes.PushConfigDocument> => {
    try {
      // Fetch dapp's Push config from its hosted wc-push-config.
      const pushConfigResp = await axios.get(
        `${dappUrl}/.well-known/wc-push-config.json`
      );
      const pushConfig = pushConfigResp.data;

      this.client.logger.info(
        `[Notify] subscribe > got push config: ${JSON.stringify(pushConfig)}`
      );
      return pushConfig;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch dapp's Push config from ${dappUrl}/.well-known/wc-push-config.json. Error: ${error.message}`
      );
    }
  };

  private generateScopeMapFromConfig = (
    typesConfig: PushClientTypes.PushConfigDocument["types"],
    selected?: string[]
  ): PushClientTypes.ScopeMap => {
    return typesConfig.reduce((map, type) => {
      map[type.name] = {
        description: type.description,
        enabled: selected?.includes(type.name) ?? true,
      };
      return map;
    }, {});
  };
}
