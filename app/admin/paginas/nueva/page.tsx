import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { PageHeader } from "../../_components/ui";
import { EditorPagina } from "../../contenido/_components/BlockEditor";
import "../../contenido/contenido.css";

/**
 * Página nueva.
 *
 * Es el mismo editor que el de una página existente, con los campos vacíos: si
 * crear y editar se vieran distinto, habría que aprender dos pantallas para
 * hacer lo mismo. Nace en borrador; publicar es un gesto aparte.
 */
export const dynamic = "force-dynamic";

export default async function NuevaPaginaPage() {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  return (
    <>
      <PageHeader
        title="Nueva página"
        subtitle="Escribe el texto y guárdalo. Se queda en borrador hasta que decidas publicarlo."
      />

      <EditorPagina
        pagina={{
          id: null,
          slug: "",
          title: "",
          content: "",
          status: "draft",
          seoTitle: "",
          seoDescription: "",
          showInFooter: true,
        }}
      />
    </>
  );
}
