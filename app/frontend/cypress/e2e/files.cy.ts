/**
 * End-to-end coverage for the signed-URL download flow.
 *
 * Drives the real stack via docker-compose.frontend-e2e.yml:
 *   Browser → Caddy (app:8000) → files:8080 (nginx + qjs HMAC verify)
 *
 * Exercises:
 *   - Upload (the existing 3-step flow: request-url → PUT to nginx → finalize)
 *   - Download URL is a signed URL (carries exp/sig/fn/ct/inline)
 *   - Fetching the signed URL returns 200 + bytes + private Cache-Control
 *   - Tampered sig is rejected with 401 by the qjs verifier
 *   - Range request returns 206 + partial bytes (the streaming win this feature
 *     exists for — proves the fast path doesn't break range support)
 */

describe("Files: signed-URL download flow", () => {
	const headers = {
		"X-Nook-User": "22222222-2222-4222-8222-222222222222",
		"X-Nook-Groups": "paith/notes",
	};

	it("upload → signed download URL → 200 + range + tamper-reject", () => {
		// Establish the user (auto-creates row on first /api/me).
		cy.request({ method: "GET", url: "/api/me", headers });

		const nookName = `files-e2e-${Date.now()}`;

		cy.request({
			method: "POST",
			url: "/api/nooks",
			headers,
			body: { name: nookName },
		}).then((createNook) => {
			expect(createNook.status).to.eq(200);
			const nookId: string = createNook.body.nook.id;

			cy.request({
				method: "GET",
				url: `/api/nooks/${nookId}/note-types`,
				headers,
			}).then((typesRes) => {
				const fileType = typesRes.body.types.find(
					(t: { key: string }) => t.key === "file",
				);
				expect(fileType, "seeded 'file' type").to.exist;
				const fileTypeId: string = fileType.id;

				cy.request({
					method: "GET",
					url: `/api/nooks/${nookId}/note-types/${fileTypeId}/attributes`,
					headers,
				}).then((attrsRes) => {
					const fileAttr = attrsRes.body.attributes.find(
						(a: { kind: string }) => a.kind === "file",
					);
					expect(fileAttr, "seeded file attribute").to.exist;
					const fileAttrId: string = fileAttr.id;

					const fileBody = "hello world from cypress e2e";
					const fileLength = fileBody.length;

					// Step 1: request a single-use upload URL.
					cy.request({
						method: "POST",
						url: `/api/nooks/${nookId}/file/attr-upload-url`,
						headers,
						body: {
							filename: "hello.txt",
							extension: "txt",
							filesize: fileLength,
							mime_type: "text/plain",
							checksum: "",
							type_id: fileTypeId,
							attribute_id: fileAttrId,
						},
					}).then((reqUrlRes) => {
						expect(reqUrlRes.status).to.eq(200);
						const uploadUrl: string = reqUrlRes.body.upload_url;
						const uploadId: string = reqUrlRes.body.upload_id;
						expect(uploadUrl).to.contain("/files/tmp/");

						// Step 2: PUT bytes directly to nginx (skipped PHP).
						cy.request({
							method: "PUT",
							url: uploadUrl,
							headers: { ...headers, "Content-Type": "text/plain" },
							body: fileBody,
						}).then((putRes) => {
							expect(putRes.status).to.be.oneOf([200, 201, 204]);

							// Step 3: finalize → moves tmp → final, hashes, inserts note_files.
							cy.request({
								method: "POST",
								url: `/api/nooks/${nookId}/file/attr-finalize`,
								headers,
								body: {
									upload_id: uploadId,
									type_id: fileTypeId,
									attribute_id: fileAttrId,
								},
							}).then((finRes) => {
								expect(finRes.status).to.eq(200);
								const noteId: string = finRes.body.note.id;

								// Get the download URL — must be the new signed shape.
								cy.request({
									method: "GET",
									url: `/api/nooks/${nookId}/notes/${noteId}/attributes/${fileAttrId}/file/download-url`,
									headers,
								}).then((dlRes) => {
									expect(dlRes.status).to.eq(200);
									const signedUrl: string = dlRes.body.download_url;

									// Contract: every signed-URL param the qjs handler needs.
									expect(signedUrl, "carries exp").to.match(/[?&]exp=\d+/);
									expect(signedUrl, "carries sig").to.match(/[?&]sig=[A-Za-z0-9_-]+/);
									expect(signedUrl, "carries fn").to.match(/[?&]fn=/);
									expect(signedUrl, "carries ct").to.match(/[?&]ct=/);
									expect(signedUrl, "carries inline").to.match(/[?&]inline=[01]/);
									expect(dlRes.body.expires_in).to.eq(7200);

									// Fetch the signed URL — qjs verifies, nginx serves bytes.
									cy.request({ method: "GET", url: signedUrl }).then((fetchRes) => {
										expect(fetchRes.status).to.eq(200);
										expect(fetchRes.body).to.eq(fileBody);
										const cd = String(fetchRes.headers["content-disposition"] ?? "");
										expect(cd).to.contain("hello.txt");
										const cc = String(fetchRes.headers["cache-control"] ?? "");
										expect(cc).to.contain("private");
										expect(cc).to.match(/max-age=\d+/);
									});

									// Tampered sig → 401. Replace the last sig char with one that
									// doesn't appear there.
									const tamperedUrl = signedUrl.replace(
										/(sig=[A-Za-z0-9_-]+)/,
										(_, sig) => {
											const last = sig.slice(-1);
											const swap = last === "A" ? "B" : "A";
											return `sig=${sig.slice(0, -1)}${swap}`;
										},
									);
									cy.request({
										method: "GET",
										url: tamperedUrl,
										failOnStatusCode: false,
									}).then((tampRes) => {
										expect(tampRes.status).to.eq(401);
									});

									// Range request — proves the fast path supports byte ranges,
									// which is the whole reason this feature exists.
									cy.request({
										method: "GET",
										url: signedUrl,
										headers: { Range: "bytes=0-4" },
									}).then((rangeRes) => {
										expect(rangeRes.status).to.eq(206);
										expect(String(rangeRes.body)).to.eq(fileBody.slice(0, 5));
										const cr = String(rangeRes.headers["content-range"] ?? "");
										expect(cr).to.contain("bytes 0-4");
									});
								});
							});
						});
					});
				});
			});
		});
	});
});
