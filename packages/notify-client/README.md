# Notify Client

> Notify Client is currently under active development. This means updates could modify the API, remove deprecated features, or change default behavior.
>
> Please check the [release summaries](https://github.com/WalletConnect/notify-client-js/releases) for any notes on important changes between versions.

This is the underlying client for `@web3inbox/core` and follows the specs defined [here](https://specs.walletconnect.com/2.0/specs/clients/notify/client-sdk-api).

It is very terse in order to be compliant with the aforementioned platform-agnostic spec. It is heavily recommended to use `@web3inbox/core` and (optionally) its React wrapper `@web3inbox/react` as the API of these libraries is optimized to be dev friendly and will integrate easier on the UI. This is true for both **wallets** and **web apps**.
