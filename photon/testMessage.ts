import { IMessageSDK } from "@photon-ai/imessage-kit";

const sdk = new IMessageSDK();
await sdk.send({ to: "+16317486785", text: "Hello from iMessage Kit!" });
await sdk.close();


