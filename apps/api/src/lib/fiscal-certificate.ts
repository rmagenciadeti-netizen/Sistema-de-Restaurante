import { createSign, createVerify, randomBytes } from 'node:crypto';
import forge from 'node-forge';

export class CertificateError extends Error { constructor(message: string, readonly status = 422) { super(message); } }

export type ParsedCertificate = {
  certPem: string; keyPem: string; chainPem: string[];
  subject: string; holder: string; cnpj: string | null; cpf: string | null; issuer: string; serial: string;
  validFrom: Date; validTo: Date; icpBrasil: boolean; keyMatches: boolean;
};

const ICP_CNPJ_OID = '2.16.76.1.3.3';
const ICP_PF_OID = '2.16.76.1.3.1';
const dn = (attributes: forge.pki.CertificateField[]) => attributes.map(item => `${item.shortName ?? item.name ?? item.type}=${String(item.value)}`).join(', ');

// ICP-Brasil puts the e-CNPJ/e-CPF number in subjectAltName otherName fields (DOC-ICP-04); the CN suffix ":CNPJ" is only a fallback.
function icpOtherNames(cert: forge.pki.Certificate): Map<string, string> {
  const found = new Map<string, string>();
  const ext = cert.extensions.find(item => item.id === '2.5.29.17') as { value?: string } | undefined;
  if (!ext?.value) return found;
  const walk = (node: forge.asn1.Asn1) => {
    if (Array.isArray(node.value)) {
      const [first, second] = node.value as forge.asn1.Asn1[];
      if (first?.type === forge.asn1.Type.OID && typeof first.value === 'string' && second) {
        const oid = forge.asn1.derToOid(first.value);
        const text = (function leaf(item: forge.asn1.Asn1): string { return typeof item.value === 'string' ? item.value : (item.value as forge.asn1.Asn1[]).map(leaf).join(''); })(second);
        found.set(oid, text);
      }
      (node.value as forge.asn1.Asn1[]).forEach(walk);
    }
  };
  try { walk(forge.asn1.fromDer(ext.value)); } catch { /* malformed SAN: fall back to the subject */ }
  return found;
}

// Opens a PKCS#12 (.pfx/.p12) file with its password, extracts the end-entity certificate and the private key, and proves they belong together.
export function parsePfx(pfx: Buffer, password: string): ParsedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary'))), false, password); }
  catch (error) {
    const text = error instanceof Error ? error.message : '';
    throw new CertificateError(/MAC|password|decrypt/i.test(text) ? 'Senha do certificado incorreta.' : 'Arquivo inválido: envie o certificado A1 no formato .pfx ou .p12.');
  }
  const keyBag = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])].find(bag => bag.key);
  if (!keyBag?.key) throw new CertificateError('O arquivo não contém a chave privada (exporte o certificado A1 com a chave privada).');
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map(bag => bag.cert).filter((cert): cert is forge.pki.Certificate => Boolean(cert));
  if (certs.length === 0) throw new CertificateError('O arquivo não contém certificado.');
  const key = keyBag.key as forge.pki.rsa.PrivateKey;
  if (!('n' in key)) throw new CertificateError('Somente chaves RSA são aceitas para NF-e/NFC-e.');
  const leaf = certs.find(cert => (cert.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n)) ?? null;
  if (!leaf) throw new CertificateError('A chave privada não corresponde a nenhum certificado do arquivo.');
  const keyPem = forge.pki.privateKeyToPem(key); const certPem = forge.pki.certificateToPem(leaf);
  // Proves possession: signs a random challenge with the private key and verifies it with the certificate.
  const challenge = randomBytes(32);
  const keyMatches = createVerify('RSA-SHA256').update(challenge).verify(certPem, createSign('RSA-SHA256').update(challenge).sign(keyPem));
  const other = icpOtherNames(leaf);
  const cn = String(leaf.subject.getField('CN')?.value ?? '');
  const cnpj = (other.get(ICP_CNPJ_OID)?.replace(/\D/g, '').slice(0, 14) || /:(\d{14})(?:\D|$)/.exec(cn)?.[1]) ?? null;
  const pfData = other.get(ICP_PF_OID)?.replace(/\D/g, '');
  return {
    certPem, keyPem, chainPem: certs.filter(cert => cert !== leaf).map(cert => forge.pki.certificateToPem(cert)),
    subject: dn(leaf.subject.attributes), holder: cn.replace(/:\d{11,14}$/, ''), cnpj: cnpj && cnpj.length === 14 ? cnpj : null,
    cpf: pfData && pfData.length >= 19 ? pfData.slice(8, 19) : null, issuer: dn(leaf.issuer.attributes), serial: leaf.serialNumber,
    validFrom: leaf.validity.notBefore, validTo: leaf.validity.notAfter, icpBrasil: /ICP-Brasil/i.test(dn(leaf.issuer.attributes)), keyMatches,
  };
}

export type CertificateCheck = { state: 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NOT_YET_VALID' | 'INVALID'; problems: string[]; warnings: string[]; daysLeft: number };
// Problems block saving; warnings are shown but accepted (e.g. a test certificate outside ICP-Brasil, which SEFAZ will reject).
export function checkCertificate(cert: ParsedCertificate, issuerCnpj: string | null, now = new Date()): CertificateCheck {
  const problems: string[] = []; const warnings: string[] = [];
  const daysLeft = Math.floor((cert.validTo.getTime() - now.getTime()) / 86_400_000);
  if (!cert.keyMatches) problems.push('A chave privada não corresponde ao certificado.');
  if (cert.validTo < now) problems.push(`Certificado vencido em ${cert.validTo.toLocaleDateString('pt-BR')}.`);
  if (cert.validFrom > now) problems.push(`Certificado válido somente a partir de ${cert.validFrom.toLocaleDateString('pt-BR')}.`);
  if (!cert.cnpj) problems.push('O certificado não é um e-CNPJ (CNPJ não identificado). NF-e/NFC-e exigem certificado de pessoa jurídica.');
  else if (issuerCnpj && cert.cnpj.slice(0, 8) !== issuerCnpj.slice(0, 8)) problems.push(`Certificado incompatível: pertence ao CNPJ ${cert.cnpj}, de outra empresa que o emitente (${issuerCnpj}).`);
  else if (issuerCnpj && cert.cnpj !== issuerCnpj) warnings.push(`O certificado é do CNPJ ${cert.cnpj} (mesma raiz do emitente ${issuerCnpj}); a SEFAZ aceita a assinatura pela matriz.`);
  if (!cert.icpBrasil) warnings.push('O certificado não foi emitido por AC da ICP-Brasil: a SEFAZ recusará a comunicação.');
  if (daysLeft >= 0 && daysLeft <= 30) warnings.push(`O certificado vence em ${daysLeft} dia(s).`);
  const state = problems.some(item => item.includes('não corresponde') || item.includes('e-CNPJ') || item.includes('incompatível')) ? 'INVALID' : cert.validTo < now ? 'EXPIRED' : cert.validFrom > now ? 'NOT_YET_VALID' : daysLeft <= 30 ? 'EXPIRING' : 'VALID';
  return { state, problems, warnings, daysLeft };
}
