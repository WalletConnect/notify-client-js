import { RELAYER_DEFAULT_PROTOCOL, RELAYER_EVENTS } from "@walletconnect/core";
import {
  JwtPayload,
  composeDidPkh,
  encodeEd25519Key,
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
import { JsonRpcRecord, RelayerTypes } from "@walletconnect/types";
import {
  TYPE_1,
  deriveSymKey,
  getInternalError,
  hashKey,
} from "@walletconnect/utils";
import axios from "axios";
import jwtDecode, { InvalidTokenError } from "jwt-decode";

import {
  DID_WEB_PREFIX,
  ENGINE_RPC_OPTS,
  JWT_SCP_SEPARATOR,
  LAST_WATCHED_KEY,
  NOTIFY_AUTHORIZATION_STATEMENT,
} from "../constants";
import { INotifyEngine, JsonRpcTypes, NotifyClientTypes } from "../types";
import { getDappUrl } from "../utils/formats";

export class NotifyEngine extends INotifyEngine {
  public name = "notifyEngine";
  private initialized = false;

  private didDocMap = new Map<string, NotifyClientTypes.NotifyDidDocument>();

  constructor(client: INotifyEngine["client"]) {
    super(client);
  }

  public init: INotifyEngine["init"] = async () => {
    if (!this.initialized) {
      this.registerRelayerEvents();
      this.client.core.pairing.register({
        methods: Object.keys(ENGINE_RPC_OPTS),
      });

      await this.watchLastWatchedAccountIfExists();

      this.initialized = true;
    }
  };

  // ---------- Public --------------------------------------- //

  public register: INotifyEngine["register"] = async ({
    account,
    onSign,
    domain,
  }) => {
    const statement = NOTIFY_AUTHORIZATION_STATEMENT;

    // Retrieve existing identity or register a new one for this account on this device.
    const identity = await this.registerIdentity(
      account,
      onSign,
      statement,
      domain
    );

    try {
      await this.watchSubscriptions(account);
    } catch (error: any) {
      this.client.logger.error(
        `[Notify] Engine.register > watching subscriptions failed > ${error.message}`
      );
    }

    return identity;
  };

  public subscribe: INotifyEngine["subscribe"] = async ({
    appDomain,
    account,
  }) => {
    this.isInitialized();

    const dappUrl = getDappUrl(appDomain);
    const { dappPublicKey, dappIdentityKey } = await this.resolveKeys(dappUrl);
    const notifyConfig = await this.resolveNotifyConfig(dappUrl);

    this.client.logger.info(
      `[Notify] subscribe > publicKey for ${dappUrl} is: ${dappPublicKey}`
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
    const identityKeyPub = await this.client.identityKeys.getIdentity({
      account,
    });
    const issuedAt = Math.round(Date.now() / 1000);
    const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifySubscribe"].req.ttl;
    const scp = notifyConfig.types
      .map((type) => type.name)
      .join(JWT_SCP_SEPARATOR);
    const payload: NotifyClientTypes.SubscriptionJWTClaims = {
      iat: issuedAt,
      exp: expiry,
      iss: encodeEd25519Key(identityKeyPub),
      sub: composeDidPkh(account),
      aud: encodeEd25519Key(dappIdentityKey),
      ksu: this.client.keyserverUrl,
      scp,
      act: "notify_subscription",
      app: `${DID_WEB_PREFIX}${appDomain}`,
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

    return { id, subscriptionAuth };
  };

  public update: INotifyEngine["update"] = async ({ topic, scope }) => {
    this.isInitialized();

    this.client.logger.info(
      `[Notify] update > updating notify subscription for topic ${topic} with new scope: ${JSON.stringify(
        scope
      )}`
    );

    let subscription: NotifyClientTypes.NotifySubscription;

    // Retrieves the known subscription for the given topic or throws if no subscription is found.
    try {
      subscription = this.client.subscriptions.get(topic);
    } catch (error) {
      throw new Error(
        `update(): No subscription found to update for the given topic: ${topic}`
      );
    }

    const updateAuth = await this.generateUpdateAuth({ subscription, scope });

    this.client.logger.info(
      `[Notify] update > generated updateAuth JWT: ${updateAuth}`
    );

    const id = await this.sendRequest(topic, "wc_notifyUpdate", {
      updateAuth,
    });

    this.client.logger.info({
      action: "sendRequest",
      method: "wc_notifyUpdate",
      id,
      topic,
      updateAuth,
    });

    return true;
  };

  public decryptMessage: INotifyEngine["decryptMessage"] = async ({
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

      if (!("messageAuth" in payload.params)) {
        throw new Error(
          "Invalid message payload provided to `decryptMessage`: expected `messageAuth` key to be present."
        );
      }

      const messageClaims =
        this.decodeAndValidateJwtAuth<NotifyClientTypes.MessageJWTClaims>(
          payload.params.messageAuth,
          "notify_message"
        );

      return messageClaims.msg;
    } catch (error: any) {
      throw new Error(
        `Could not decode payload "${encryptedMessage}" on topic ${topic}: ${
          error.message || error
        }`
      );
    }
  };

  public getMessageHistory: INotifyEngine["getMessageHistory"] = ({
    topic,
  }) => {
    this.isInitialized();

    return this.client.messages.keys.includes(topic)
      ? this.client.messages.get(topic).messages
      : {};
  };

  public deleteSubscription: INotifyEngine["deleteSubscription"] = async ({
    topic,
  }) => {
    this.isInitialized();

    const deleteAuth = await this.generateDeleteAuth({
      topic,
    });

    await this.sendRequest(topic, "wc_notifyDelete", { deleteAuth });

    this.client.logger.info(
      `[Notify] Engine.delete > deleted notify subscription on topic ${topic}`
    );
  };

  public deleteNotifyMessage: INotifyEngine["deleteNotifyMessage"] = ({
    id,
  }) => {
    this.isInitialized();

    const targetRecord = this.client.messages
      .getAll()
      .find((record) => record.messages[id]);

    if (!targetRecord) {
      throw new Error(
        `No message with id ${id} found in notify message history.`
      );
    }

    delete targetRecord.messages[id];

    this.client.messages.update(targetRecord.topic, targetRecord);
  };

  public getActiveSubscriptions: INotifyEngine["getActiveSubscriptions"] = (
    params
  ) => {
    this.isInitialized();

    const subscriptions = this.client.subscriptions
      .getAll(params)
      .map((subscription) => [subscription.topic, subscription]);

    return Object.fromEntries(subscriptions);
  };

  // ---------- Protected Helpers --------------------------------------- //

  protected sendRequest: INotifyEngine["sendRequest"] = async (
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

  protected sendResult: INotifyEngine["sendResult"] = async (
    id,
    topic,
    result,
    encodeOpts
  ) => {
    // If the initial request is not in the history, do not attempt to send a result.
    // E.g. receiving a `wc_notifyMessage` res sent by another client before this client
    // processes/receives the initial req.
    if (!this.client.core.history.keys.includes(id)) {
      this.client.logger.info(
        `[Notify] Engine.sendResult > ignoring result for unknown request id ${id} without history record on topic ${topic}.`
      );
      return id;
    }
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
    this.client.core.history.delete(topic, payload.id);

    return payload.id;
  };

  protected sendError: INotifyEngine["sendError"] = async (
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
    this.client.core.history.delete(topic, payload.id);

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
          await this.onRelayEventResponse({
            topic,
            payload,
            publishedAt,
          });
          this.client.core.history.delete(topic, payload.id);
        }
      }
    );
  }

  protected onRelayEventRequest: INotifyEngine["onRelayEventRequest"] = (
    event
  ) => {
    const { topic, payload, publishedAt } = event;
    const reqMethod = payload.method as JsonRpcTypes.WcMethod;

    switch (reqMethod) {
      case "wc_notifyMessage":
        return this.onNotifyMessageRequest(topic, payload, publishedAt);
      case "wc_notifyDelete":
        return this.onNotifyDeleteRequest(topic, payload);
      case "wc_notifySubscriptionsChanged":
        return this.onNotifySubscriptionsChangedRequest(topic, payload);
      default:
        return this.client.logger.info(
          `[Notify] Unsupported request method ${reqMethod}`
        );
    }
  };

  protected onRelayEventResponse: INotifyEngine["onRelayEventResponse"] =
    async (event) => {
      const { topic, payload } = event;
      let record: JsonRpcRecord;

      if (this.client.core.history.keys.includes(payload.id)) {
        record = await this.client.core.history.get(topic, payload.id);
      } else {
        this.client.logger.info(
          "[Notify] Engine.onRelayEventResponse > ignoring response for unknown request without history record."
        );
        return;
      }

      const resMethod = record.request.method as JsonRpcTypes.WcMethod;

      switch (resMethod) {
        case "wc_notifySubscribe":
          return this.onNotifySubscribeResponse(topic, payload);
        case "wc_notifyMessage":
          return this.onNotifyMessageResponse(topic, payload);
        case "wc_notifyDelete":
          return this.onNotifyDeleteResponse(topic, payload);
        case "wc_notifyUpdate":
          return this.onNotifyUpdateResponse(topic, payload);
        case "wc_notifyWatchSubscription":
          return this.onNotifyWatchSubscriptionsResponse(topic, payload);
        default:
          return this.client.logger.info(
            `[Notify] Unsupported response method ${resMethod}`
          );
      }
    };

  // ---------- Relay Event Handlers --------------------------------- //

  protected onNotifySubscribeResponse: INotifyEngine["onNotifySubscribeResponse"] =
    async (responseTopic, response) => {
      this.client.logger.info(
        `onNotifySubscribeResponse on response topic ${responseTopic}`
      );

      if (isJsonRpcResult(response)) {
        const { id } = response;

        this.client.logger.info({
          event: "onNotifySubscribeResponse",
          id,
          topic: responseTopic,
          response,
        });

        // Emit the NotifySubscription at client level.
        this.client.emit("notify_subscription", {
          id: response.id,
          topic: responseTopic,
          params: {},
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
    };

  protected onNotifyMessageRequest: INotifyEngine["onNotifyMessageRequest"] =
    async (topic, payload) => {
      this.client.logger.info({
        event: "Engine.onNotifyMessageRequest",
        topic,
        payload,
      });

      let messageClaims: NotifyClientTypes.MessageJWTClaims;

      try {
        messageClaims =
          this.decodeAndValidateJwtAuth<NotifyClientTypes.MessageJWTClaims>(
            payload.params.messageAuth,
            "notify_message"
          );
      } catch (error: any) {
        this.client.logger.error(
          `[Notify] Engine.onNotifyMessageRequest > decoding/validating messageAuth failed > ${error.message}`
        );
        await this.sendError(payload.id, topic, error);
        return;
      }

      // To account for data races occuring from history injection of notify messages
      if (!this.client.messages.keys.some((key) => key === topic)) {
        await this.client.messages.set(topic, {
          messages: {},
          topic,
        });
      }

      const currentMessages = this.client.messages.get(topic).messages;

      await this.client.messages.update(topic, {
        messages: {
          ...currentMessages,
          [payload.id]: {
            id: payload.id,
            topic,
            message: messageClaims.msg,
            // Not using publishedAt as these messages can be coming from Archive API
            // Multiplying by 1000 to get the timestamp in ms, instead of seconds
            publishedAt: messageClaims.iat * 1000,
          },
        },
      });

      try {
        const responseAuth = await this.generateMessageResponseAuth({
          topic,
        });

        this.client.logger.info(
          `[Notify] Engine.onNotifyMessageRequest > generated responseAuth JWT: ${responseAuth}`
        );

        await this.sendResult<"wc_notifyMessage">(payload.id, topic, {
          responseAuth,
        });
      } catch (error: any) {
        this.client.logger.error(
          `[Notify] Engine.onNotifyMessageRequest > generating responseAuth failed: ${error.message}`
        );
        await this.sendError(payload.id, topic, {
          code: -1,
          message: error.message || error,
        });
      }
      this.client.emit("notify_message", {
        id: payload.id,
        topic,
        params: { message: messageClaims.msg },
      });
    };

  protected onNotifyMessageResponse: INotifyEngine["onNotifyMessageResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Notify] Engine.onNotifyMessageResponse > result:",
          topic,
          payload
        );
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Notify] Engine.onNotifyMessageResponse > error:",
          topic,
          payload.error
        );
      }
    };

  protected onNotifyDeleteRequest: INotifyEngine["onNotifyDeleteRequest"] =
    async (topic, payload) => {
      const { id } = payload;
      this.client.logger.info(
        "[Notify] Engine.onNotifyDeleteRequest",
        topic,
        payload
      );
      try {
        this.client.events.emit("notify_delete", { id, topic });
      } catch (err: any) {
        this.client.logger.error(err);
        await this.sendError(id, topic, err);
      }
    };

  protected onNotifyDeleteResponse: INotifyEngine["onNotifyDeleteResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Notify] Engine.onNotifyDeleteResponse > result:",
          topic,
          payload
        );
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Notify] Engine.onNotifyDeleteResponse > error:",
          topic,
          payload.error
        );
      }
    };

  protected onNotifyWatchSubscriptionsResponse: INotifyEngine["onNotifyWatchSubscriptionsResponse"] =
    async (topic, payload) => {
      this.client.logger.info(
        "onNotifyWatchSubscriptionsResponse",
        topic,
        payload
      );

      if (isJsonRpcResult(payload)) {
        const subscriptions = await this.updateSubscriptionsUsingJwt(
          payload.result.responseAuth,
          "notify_watch_subscriptions_response"
        );

        this.client.logger.info({
          event: "notify_subscriptions_changed",
          topic,
          id: payload.id,
          subscriptions,
        });

        this.client.emit("notify_subscriptions_changed", {
          id: payload.id,
          topic,
          params: {
            subscriptions,
          },
        });
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error({
          event: "onNotifyWatchSubscriptionsResponse",
          topic,
          error: payload.error,
        });
      }
    };

  protected onNotifySubscriptionsChangedRequest: INotifyEngine["onNotifySubscriptionsChangedRequest"] =
    async (topic, payload) => {
      this.client.logger.info(
        "onNotifySubscriptionsChangedRequest",
        topic,
        payload
      );

      const subscriptions = await this.updateSubscriptionsUsingJwt(
        payload.params.subscriptionsChangedAuth,
        "notify_subscriptions_changed"
      );

      this.client.logger.info({
        event: "notify_subscriptions_changed",
        topic,
        id: payload.id,
        subscriptions,
      });

      this.client.emit("notify_subscriptions_changed", {
        id: payload.id,
        topic,
        params: {
          subscriptions,
        },
      });
    };

  protected onNotifyUpdateResponse: INotifyEngine["onNotifyUpdateResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info({
          event: "onNotifyUpdateResponse",
          topic,
          result: payload,
        });

        this.client.events.emit("notify_update", {
          id: payload.id,
          topic,
          params: {},
        });
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error({
          event: "onNotifyUpdateResponse",
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

  // ---------- Private Helpers --------------------------------- //

  private isInitialized() {
    if (!this.initialized) {
      const { message } = getInternalError("NOT_INITIALIZED", this.name);
      throw new Error(message);
    }
  }

  private async getNotifyServerWatchTopic(notifyId: string) {
    return hashKey(notifyId);
  }

  private async watchSubscriptions(accountId: string) {
    const notifyKeys = await this.resolveKeys(this.client.notifyServerUrl);

    // Derive req topic from did.json
    const notifyServerWatchTopic = await this.getNotifyServerWatchTopic(
      notifyKeys.dappPublicKey
    );

    this.client.logger.info(
      "watchSubscriptions >",
      "notifyServerWatchTopic >",
      notifyServerWatchTopic
    );

    const issuedAt = Math.round(Date.now() / 1000);
    const expiry =
      issuedAt + ENGINE_RPC_OPTS["wc_notifyWatchSubscription"].res.ttl;

    // Generate persistent key kY
    const pubKeyY = await this.client.core.crypto.generateKeyPair();
    const privKeyY = this.client.core.crypto.keychain.get(pubKeyY);
    // Generate res topic from persistent key kY
    const resTopic = hashKey(deriveSymKey(privKeyY, notifyKeys.dappPublicKey));
    // Subscribe to res topic
    await this.client.core.relayer.subscriber.subscribe(resTopic);

    const claims: NotifyClientTypes.NotifyWatchSubscriptionsClaims = {
      act: "notify_watch_subscriptions",
      iss: encodeEd25519Key(
        await this.client.identityKeys.getIdentity({ account: accountId })
      ),
      exp: expiry,
      iat: issuedAt,
      aud: encodeEd25519Key(notifyKeys.dappIdentityKey),
      ksu: this.client.keyserverUrl,
      sub: composeDidPkh(accountId),
      app: null,
    };

    const generatedAuth = await this.client.identityKeys.generateIdAuth(
      accountId,
      claims
    );

    this.client.logger.info(
      "watchSubscriptions >",
      "subscriptionAuth >",
      generatedAuth
    );

    const id = await this.sendRequest(
      notifyServerWatchTopic,
      "wc_notifyWatchSubscription",
      {
        watchSubscriptionsAuth: generatedAuth,
      },
      {
        type: TYPE_1,
        senderPublicKey: pubKeyY,
        receiverPublicKey: notifyKeys.dappPublicKey,
      }
    );

    this.client.lastWatchedAccount.set(LAST_WATCHED_KEY, {
      [LAST_WATCHED_KEY]: accountId,
    });

    this.client.logger.info("watchSubscriptions >", "requestId >", id);
  }

  private updateSubscriptionsUsingJwt = async (
    jwt: string,
    act:
      | NotifyClientTypes.NotifyWatchSubscriptionsResponseClaims["act"]
      | NotifyClientTypes.NotifySubscriptionsChangedClaims["act"]
  ) => {
    const claims = this.decodeAndValidateJwtAuth<
      | NotifyClientTypes.NotifyWatchSubscriptionsResponseClaims
      | NotifyClientTypes.NotifySubscriptionsChangedClaims
    >(jwt, act);

    this.client.logger.info("updateSubscriptionsUsingJwt > claims", claims);

    // Clean up any subscriptions that are no longer valid.
    const newStateSubsTopics = claims.sbs.map((sb) => hashKey(sb.symKey));
    for (const currentSubTopic of this.client.subscriptions
      .getAll()
      .map((sub) => sub.topic)) {
      if (!newStateSubsTopics.includes(currentSubTopic)) {
        // We only want to clean up the subscription if it was created by the current account.
        if (this.client.subscriptions.keys.includes(currentSubTopic)) {
          const existingSub = this.client.subscriptions.get(currentSubTopic);
          if (
            existingSub.account === claims.sub.split(":").slice(2).join(":")
          ) {
            this.client.logger.info(
              `[Notify] updateSubscriptionsUsingJwt > cleanupSubscription on topic ${currentSubTopic}`
            );
            await this.cleanupSubscription(currentSubTopic);
          }
        }
      }
    }

    // Update all subscriptions to account for any changes in scope.
    const updateSubscriptionsPromises = claims.sbs.map(async (sub) => {
      const sbTopic = hashKey(sub.symKey);
      const dappUrl = getDappUrl(sub.appDomain);
      const dappConfig = await this.resolveNotifyConfig(dappUrl);
      const scopeMap = this.generateScopeMap(dappConfig, sub);

      await this.client.subscriptions.set(sbTopic, {
        account: sub.account,
        expiry: sub.expiry,
        topic: sbTopic,
        scope: scopeMap,
        symKey: sub.symKey,
        metadata: {
          name: dappConfig.name,
          description: dappConfig.description,
          icons: dappConfig.icons,
          appDomain: sub.appDomain,
        },
        relay: {
          protocol: RELAYER_DEFAULT_PROTOCOL,
        },
      });

      await this.client.core.crypto.setSymKey(sub.symKey, sbTopic);
    });

    // Only set messages and symKeys for new subscriptions.
    const newSubscriptions = claims.sbs.filter(
      (sb) => !this.client.subscriptions.keys.includes(hashKey(sb.symKey))
    );

    this.client.logger.info(
      "updateSubscriptionsUsingJwt > newSubscriptions",
      newSubscriptions
    );

    const setupNewSubscriptionsPromises = newSubscriptions.map(
      (sub) => async () => {
        const sbTopic = hashKey(sub.symKey);

        try {
          //TODO: Figure out why this never resolves
          await this.client.core.relayer.subscribe(sbTopic);
        } catch (e) {
          this.client.logger.error("Failed to subscribe from claims.sbs", e);
        }

        // Set up a store for messages sent to this notify topic.
        await this.client.messages.set(sbTopic, {
          topic: sbTopic,
          messages: {},
        });

        // Set the symKey in the keychain for the new subscription.
        await this.client.core.crypto.setSymKey(sub.symKey, sbTopic);
      }
    );

    await Promise.all(updateSubscriptionsPromises);

    // Handle them sequentially because `core.relayer.subscribe` is not compatible
    // with concurrent `relayer.subscribe` requests, as a data race occurs between the two
    // subscriptions and its subscriber.once(SUBSCRIBER_EVENTS.created, ...) will be triggered
    // with a wrong subscription, seeing that the topics of the two subscriptions do not match,
    // it will not resolve.
    for (const setupNewSubscriptionPromise of setupNewSubscriptionsPromises) {
      await setupNewSubscriptionPromise();
    }

    return this.client.subscriptions.getAll();
  };

  private cleanupSubscription = async (topic: string) => {
    this.client.logger.info(`[Notify] cleanupSubscription > topic: ${topic}`);
    // Await the unsubscribe first to avoid deleting the symKey too early below.
    await this.client.core.relayer.unsubscribe(topic);
    await Promise.all([
      this.client.subscriptions.delete(topic, {
        code: -1,
        message: "Deleted subscription.",
      }),
      this.client.messages.delete(topic, {
        code: -1,
        message: "Deleted subscription.",
      }),
      this.client.core.crypto.deleteSymKey(topic),
    ]);
  };

  private generateSubscriptionAuth = async (
    accountId: string,
    payload: JwtPayload
  ) => {
    return this.client.identityKeys.generateIdAuth(accountId, payload);
  };

  private generateMessageResponseAuth = async ({
    topic,
  }: {
    topic: string;
  }) => {
    try {
      const subscription = this.client.subscriptions.get(topic);
      const identityKeyPub = await this.client.identityKeys.getIdentity({
        account: subscription.account,
      });
      const dappUrl = getDappUrl(subscription.metadata.appDomain);
      const { dappIdentityKey } = await this.resolveKeys(dappUrl);
      const issuedAt = Math.round(Date.now() / 1000);
      const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifyMessage"].res.ttl;
      const payload: NotifyClientTypes.MessageResponseJWTClaims = {
        act: "notify_message_response",
        iat: issuedAt,
        exp: expiry,
        iss: encodeEd25519Key(identityKeyPub),
        aud: encodeEd25519Key(dappIdentityKey),
        sub: composeDidPkh(subscription.account),
        app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
        ksu: this.client.keyserverUrl,
      };

      const responseAuth = await this.client.identityKeys.generateIdAuth(
        subscription.account,
        payload
      );

      return responseAuth;
    } catch (error: any) {
      throw new Error(
        `generateMessageResponseAuth failed for message on topic ${topic}: ${
          error.message || error
        }`
      );
    }
  };

  private generateDeleteAuth = async ({ topic }: { topic: string }) => {
    try {
      const subscription = this.client.subscriptions.get(topic);
      const identityKeyPub = await this.client.identityKeys.getIdentity({
        account: subscription.account,
      });
      const dappUrl = getDappUrl(subscription.metadata.appDomain);
      const { dappIdentityKey } = await this.resolveKeys(dappUrl);
      const issuedAt = Math.round(Date.now() / 1000);
      const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifyDelete"].req.ttl;
      const payload: NotifyClientTypes.DeleteJWTClaims = {
        act: "notify_delete",
        iat: issuedAt,
        exp: expiry,
        iss: encodeEd25519Key(identityKeyPub),
        aud: encodeEd25519Key(dappIdentityKey),
        sub: composeDidPkh(subscription.account),
        ksu: this.client.keyserverUrl,
        app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
      };

      const deleteAuth = await this.client.identityKeys.generateIdAuth(
        subscription.account,
        payload
      );

      return deleteAuth;
    } catch (error: any) {
      throw new Error(
        `generateDeleteAuth failed for topic ${topic}: ${
          error.message || error
        }`
      );
    }
  };

  private generateUpdateAuth = async ({
    subscription,
    scope,
  }: {
    subscription: NotifyClientTypes.NotifySubscription;
    scope: string[];
  }) => {
    try {
      const identityKeyPub = await this.client.identityKeys.getIdentity({
        account: subscription.account,
      });
      const dappUrl = getDappUrl(subscription.metadata.appDomain);
      const { dappIdentityKey } = await this.resolveKeys(dappUrl);
      const issuedAt = Math.round(Date.now() / 1000);
      const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifyUpdate"].req.ttl;
      const payload: NotifyClientTypes.UpdateJWTClaims = {
        act: "notify_update",
        iat: issuedAt,
        exp: expiry,
        iss: encodeEd25519Key(identityKeyPub),
        aud: encodeEd25519Key(dappIdentityKey),
        sub: composeDidPkh(subscription.account),
        app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
        ksu: this.client.keyserverUrl,
        scp: scope.join(JWT_SCP_SEPARATOR),
      };

      const updateAuth = await this.client.identityKeys.generateIdAuth(
        subscription.account,
        payload
      );

      return updateAuth;
    } catch (error: any) {
      throw new Error(
        `generateUpdateAuth failed for topic ${subscription.topic}: ${
          error.message || error
        }`
      );
    }
  };

  private decodeAndValidateJwtAuth = <
    T extends NotifyClientTypes.BaseJwtClaims
  >(
    jwtAuth: string,
    expectedAct: T["act"]
  ) => {
    let messageClaims: T;

    // Attempt to decode the JWT string. Will throw `InvalidTokenError` if invalid.
    try {
      messageClaims = jwtDecode<T>(jwtAuth);
    } catch (error: unknown) {
      this.client.logger.error(
        `[Notify] Engine.onNotifyMessageRequest > Failed to decode messageAuth JWT: ${jwtAuth}`
      );
      throw new Error((error as InvalidTokenError).message);
    }

    // Validate `act` claim is as expected.
    if (messageClaims.act !== expectedAct) {
      throw new Error(
        `Invalid messageAuth JWT act claim: ${messageClaims.act}. Expected "${expectedAct}"`
      );
    }

    return messageClaims;
  };

  private registerIdentity = async (
    accountId: string,
    onSign: (message: string) => Promise<string>,
    statement: string,
    domain: string
  ): Promise<string> => {
    return this.client.identityKeys.registerIdentity({
      accountId,
      onSign,
      statement,
      domain,
    });
  };

  private resolveKeys = async (
    dappUrl: string
  ): Promise<{ dappPublicKey: string; dappIdentityKey: string }> => {
    let didDoc: NotifyClientTypes.NotifyDidDocument;

    this.client.logger.debug("didDocMap: ", this.didDocMap);

    // Check if we've already fetched the dapp's DID doc.
    if (this.didDocMap.has(dappUrl)) {
      didDoc = this.didDocMap.get(dappUrl)!;
    } else {
      // If not, fetch dapp's public key from its hosted DID doc.
      try {
        const didDocResp = await axios.get(`${dappUrl}/.well-known/did.json`);
        didDoc = didDocResp.data;
        this.didDocMap.set(dappUrl, didDoc);
      } catch (error: any) {
        throw new Error(
          `Failed to fetch dapp's DID doc from ${dappUrl}/.well-known/did.json. Error: ${error.message}`
        );
      }
    }

    // Look up the required keys for keyAgreement and authentication in the didDoc.
    const keyAgreementVerificationMethod = didDoc.verificationMethod.find(
      (vm) => vm.id === didDoc.keyAgreement[0]
    );
    const authenticationVerificationMethod = didDoc.verificationMethod.find(
      (vm) => vm.id === didDoc.authentication[0]
    );

    if (!keyAgreementVerificationMethod) {
      throw new Error(
        `No keyAgreement verification method found in DID doc for ${dappUrl}`
      );
    }
    if (!authenticationVerificationMethod) {
      throw new Error(
        `No authentication verification method found in DID doc for ${dappUrl}`
      );
    }

    // Derive the dappPublicKey and dappIdentityKey from the JWKs.
    const { publicKeyJwk } = keyAgreementVerificationMethod;
    const base64Jwk = publicKeyJwk.x.replace(/-/g, "+").replace(/_/g, "/");
    const dappPublicKey = Buffer.from(base64Jwk, "base64").toString("hex");

    const { publicKeyJwk: identityKeyJwk } = authenticationVerificationMethod;
    const base64IdentityJwk = identityKeyJwk.x
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const dappIdentityKey = Buffer.from(base64IdentityJwk, "base64").toString(
      "hex"
    );

    this.client.logger.info(
      `[Notify] resolveKeys > publicKey for ${dappUrl} is: ${dappPublicKey}`
    );

    return { dappPublicKey, dappIdentityKey };
  };

  private resolveNotifyConfig = async (
    dappUrl: string
  ): Promise<NotifyClientTypes.NotifyConfigDocument> => {
    try {
      // Fetch dapp's Notify config from its hosted wc-notify-config.
      const notifyConfigResp = await axios.get(
        `${dappUrl}/.well-known/wc-notify-config.json`
      );
      const notifyConfig = notifyConfigResp.data;

      this.client.logger.info(
        `[Notify] subscribe > got notify config: ${JSON.stringify(
          notifyConfig
        )}`
      );
      return notifyConfig;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch dapp's Notify config from ${dappUrl}/.well-known/wc-notify-config.json. Error: ${error.message}`
      );
    }
  };

  private generateScopeMap = (
    dappConfig: NotifyClientTypes.NotifyConfigDocument,
    serverSub: NotifyClientTypes.NotifyServerSubscription
  ): NotifyClientTypes.ScopeMap => {
    return Object.fromEntries(
      dappConfig.types.map((type) => {
        return [
          type.name,
          {
            ...type,
            enabled: serverSub.scope.includes(type.name),
          },
        ];
      })
    );
  };

  private watchLastWatchedAccountIfExists = async () => {
    // If an account was previously watched
    if (this.client.lastWatchedAccount.keys.length === 1) {
      const { lastWatched: account } =
        this.client.lastWatchedAccount.get(LAST_WATCHED_KEY);

      try {
        // Account for invalid state where the last watched account does not have an identity.
        const identity = await this.client.identityKeys.getIdentity({
          account,
        });
        if (!identity) {
          throw new Error(
            `No identity key found for lastWatchedAccount ${account}`
          );
        }
      } catch (error) {
        this.client.logger.error(
          `[Notify] Engine > watchLastWatchedAccountIfExists failed: ${error}`
        );
        return;
      }

      try {
        await this.watchSubscriptions(account);
      } catch (error: any) {
        this.client.logger.error(
          `[Notify] Engine.watchLastWatchedAccountIfExists > Failed to watch subscriptions for account ${account} > ${error.message}`
        );
      }
    }
  };
}
