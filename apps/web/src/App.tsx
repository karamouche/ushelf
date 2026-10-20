import { Route, Routes } from "react-router-dom";
import { Library } from "./pages/Library.js";
import { Reader } from "./pages/Reader.js";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Library />} />
      <Route path="/items/:id" element={<Reader />} />
    </Routes>
  );
}
