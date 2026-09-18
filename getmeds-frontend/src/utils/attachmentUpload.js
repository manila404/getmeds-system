/**
 * Sep 18, 2026: the same 3-step signed-URL upload PaymentProofPanel.jsx uses,
 * pulled out so a resubmit dialog can attach a file without duplicating it.
 * See that file's header comment for why step 2 talks to Supabase directly
 * rather than through our own API (Vercel's 4.5 MB body cap).
 */
export async function uploadOrderAttachment(client, orderId, file, fileType = 'payment_proof') {
  const { data: urlRes } = await client.post(`/api/orders/${orderId}/attachments/upload-url`, {
    contentType: file.type,
    fileName: file.name,
    fileSize: file.size,
    file_type: fileType,
  });
  const { signedUrl, storagePath } = urlRes.data;

  const put = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Upload to storage failed (${put.status}). Nothing was recorded — please try again.`);
  }

  const { data: confirmRes } = await client.post(`/api/orders/${orderId}/attachments`, {
    storagePath,
    fileName: file.name,
    contentType: file.type,
    fileSize: file.size,
    file_type: fileType,
  });
  return confirmRes.data;
}

export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export const ATTACHMENT_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,' +
  'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
