import { Link } from "react-router-dom";

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="uShelf home">
      <span>u</span>Shelf
    </Link>
  );
}
