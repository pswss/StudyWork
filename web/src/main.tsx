import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(<App />);
