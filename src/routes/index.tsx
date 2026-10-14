import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Balcão — o atendente que cobre as horas em que você fecha" },
      { name: "description", content: "Seus clientes recebem respostas sobre preços, horários e serviços, 24 horas por dia." },
      { property: "og:title", content: "Balcão — atendimento 24 horas no WhatsApp" },
      { property: "og:description", content: "Seus clientes recebem respostas. Mesmo quando você não está disponível." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <iframe
      src="/balcao.html"
      title="Balcão"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: 0 }}
    />
  );
}
