import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { GAMES, getGame } from "@/lib/games";
import { GamePlayer } from "./GamePlayer";

export function generateStaticParams() {
  return GAMES.map((g) => ({ slug: g.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const game = getGame(params.slug);
  if (!game) return { title: "Game — Neon Royale" };
  return {
    title: `${game.name} — Neon Royale`,
    description: game.blurb,
  };
}

export default function GamePage({ params }: { params: { slug: string } }) {
  const game = getGame(params.slug);
  if (!game) notFound();
  return <GamePlayer slug={params.slug} />;
}
