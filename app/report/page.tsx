import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { listRooms, listSchools } from "@/lib/repo";
import ReportForm from "./ReportForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Report a room" };

export default function ReportPage() {
  const db = getDb();
  const schools = listSchools(db);
  const rooms = schools.flatMap((s) => listRooms(db, s.id));
  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-semibold tracking-tight">How hot is it in here?</h1>
      <p className="mt-1 text-sm text-muted">
        One reading from a thermometer or thermostat. Takes ten seconds and sharpens every prediction for this room.
      </p>
      <ReportForm schools={schools} rooms={rooms} />
    </div>
  );
}
