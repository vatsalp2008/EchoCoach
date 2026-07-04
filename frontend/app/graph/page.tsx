import WeaknessGraph from "@/components/WeaknessGraph";

export default function GraphPage() {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-12">
      <div className="w-full max-w-4xl">
        <header className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Weakness graph</h1>
          <p className="mt-1.5 text-base text-muted">
            Your evolving map of interview topics. Color = current signal, size =
            how often it&apos;s come up. Mastered topics get archived out of rotation.
          </p>
        </header>
        <WeaknessGraph />
      </div>
    </main>
  );
}
