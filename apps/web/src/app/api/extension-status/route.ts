import { cookies } from "next/headers";

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://localhost:3333";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";

export async function GET() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("toon-squad-uid")?.value;

  if (!userId) {
    return Response.json({ status: "no-session", extension: false });
  }

  try {
    const res = await fetch(
      `${BRIDGE_URL}/health?userId=${encodeURIComponent(userId)}`,
      {
        headers: { Authorization: `Bearer ${BRIDGE_SECRET}` },
      },
    );
    const data = await res.json();
    return Response.json(data);
  } catch {
    return Response.json({ status: "error", extension: false });
  }
}
