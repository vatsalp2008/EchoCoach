import WeaknessGraph from "@/components/WeaknessGraph";

export default function GraphPage() {
  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900 flex flex-col items-center px-4 py-12">
      <div className="w-full max-w-4xl">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Weakness graph</h1>
          <p className="text-sm text-neutral-500">
            Your evolving map of interview topics. Color = current signal, size =
            how often it&apos;s come up. Mastered topics get archived out of rotation.
          </p>
        </header>
        <WeaknessGraph />
      </div>
    </main>
  );
}
