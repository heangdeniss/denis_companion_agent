import "./styles.css";
import { installConsoleBridge } from "./logger";
import { bootstrap } from "./app";

installConsoleBridge();

void bootstrap().catch((error) => {
  console.error("bootstrap failed", error);
});
