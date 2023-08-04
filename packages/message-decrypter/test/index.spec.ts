import { expect, describe, it } from "vitest";
import { decryptMessage } from "./../src/index";

describe("message-decrypter", () => {
  it("should decrypt the provided payload successfully", async () => {
    const messageAuthJWTClaims = {
      iat: 1691064651,
      exp: 1693656651,
      iss: "did:key:z6MksfkEMFdEWmGiy9rnyrJSxovfKZVB3sAFjVSvKw78bAR1",
      ksu: "https://keys.walletconnect.com",
      aud: "did:pkh:eip155:1:0x5662B7a32345d843368c60830f3E2b015022BCE1",
      act: "notify_message",
      sub: "0028688c3cfd8604de08297cd48e37662c2a2a8078302bfd42ed45d90114a41c",
      app: "https://gm.walletconnect.com",
      msg: {
        title: "Test Message",
        body: "Test",
        icon: "",
        url: "https://test.coms",
        type: "gm_hourly",
      },
    };

    const params = {
      topic: "cf4ddc421a73353801dcd26f64e21fa3877ccc98e577a20a7b092337b0ab76ba",
      encoded:
        "AEF6IGr77rxh1aBhi1skQCrAsmylWRl/pKO6oq1/yX96VrCdeVA+hyApAy7vszCrNc6jhi0WXtm3iMW8A0HtLA0LktpD78EmAnCgEQt7NyVxFP2TJS3R+jadzMiDYAAkHAXzLsdVCeuCxtFoawfY1SPN/C/hVeKeFzYNPEy8XvLhC3YO07ehHuM3HWprf1xLkkJBs963kJqJLwMKmNimbl8Ij2zAr7f3I4juPmf8A1SZq06Do8hUjPmVY/Y8/NzKYp4+Mwd6e0ekafvrT/bHV0+bITmL7wirYWvKRjZWCXInz7+wEza6Y7UzjF+l1zlMTiqnbsEvXJulqZVnRo1uwZP6+JQwrNmsPYTYSU0We2gUcLvU180LLgDHBqo+coo2WhgzL++47SGI2e5ujj1icH8bQGkJsmYZ1EjG2XIiIalBM8HYU8eTASRpGI5qOQhLDk65T0jLyHJnVq1g2ruSNO9FxuMyqhXEyuG7yNthSDo7s7pV477sAMaGVRizR5lrNkLwmgDGDgLNUsqytsxQUC8OQYJfRaW2qpYHF+ux6/GpB/apgqN25GbYKs85hRLbLoe5QlCbTu1efKWv1b0BpS603De2IOy3Gtl8oQOpR8KlwZ2NBGpx8S0sOMR3WVF/ElEls8pD6pa5/nQnEEwnj8lmqE1jskZ9GWmSC0Li+aPhugdLWlvPYb26jfoXpQh5m8vKVDFL/uDW7hbtF/S4BbxdpiWnW6f/EzFguaXSRtQpzSQHsaHcif7gp5+5IZwYxMs49Ye6i3N3yr49f1lyaMGjzr3751vCJuDTEk6l/STMy7iIPB6jKG9ccBmeL1cpGzFg+t/hcaKxFTsWvJvQYLqBnB2swcNalc3gdjOIHiqDADaXig9ewFs271x9umwX5bAHuUHrfHgdlpyADqIGG+tA1UNR1pChvDLDYQ+ZDPtUejzbMAXEzpW+oVroA9BtFRol0OcaYc7DEJvDg7tqqX6C5f5nfqx6VFkrAouXHURy26yHJ+zWW3Ivwj8BXGdTY4IlfzkNheZrO0ODwLFk/gzgsc7wBts1rDoQeFZBccbJjV4XERgzBG469U4UjYrnzVhHo1XkmSvweOyGg+DZqE6sOQ==",
      symkey:
        "3a9a380042fc94a50bf8a1f7e8fea86956fc8362641d78fa62970e835d770180",
    };

    const result = await decryptMessage(params);
    expect(result).toStrictEqual(messageAuthJWTClaims.msg);
  });
});
