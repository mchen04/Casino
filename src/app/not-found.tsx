import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <p className="font-display text-7xl font-black gold-text">404</p>
        <h1 className="mt-2 font-display text-2xl font-bold text-white">
          This table is closed
        </h1>
        <p className="mt-2 text-white/50">
          The game you’re looking for isn’t on the floor.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-gradient-to-b from-gold-light to-gold-dark px-6 py-3 font-semibold text-ink shadow-gold"
        >
          Back to the Lobby
        </Link>
      </div>
    </div>
  );
}
