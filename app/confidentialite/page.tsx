import Link from "next/link";
import { eventInfo } from "@/lib/utils";

export const metadata = {
  title: "Politique de confidentialité",
  description:
    "Quelles données BIS 2027 collecte, pourquoi, combien de temps, et comment exercer vos droits."
};

// Public privacy policy — REQUIRED by Google Play and the App Store (a public
// URL must be provided in both consoles). The text below describes exactly
// what the application does today. Items marked « À COMPLÉTER » are legal
// facts only the organiser can supply (legal entity, postal address,
// retention periods, hosting country): they must be filled and reviewed by
// the organiser's legal adviser BEFORE the store submission.

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-10 font-display text-xl font-black tracking-tight text-ink">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[14.5px] leading-relaxed text-ink/75">{children}</p>;
}

function Li({ children }: { children: React.ReactNode }) {
  return <li className="mt-1.5 text-[14.5px] leading-relaxed text-ink/75">{children}</li>;
}

export default function ConfidentialitePage() {
  return (
    <section className="container-page py-14">
      <div className="mx-auto max-w-3xl">
        <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-cobalt">
          Confidentialité
        </p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight text-ink sm:text-4xl">
          Politique de confidentialité
        </h1>
        <p className="mt-3 text-[13px] text-ink/50">
          Site web et application mobile {eventInfo.shortName} · Dernière mise à jour : octobre 2026
        </p>

        <H>1. Qui est responsable de vos données ?</H>
        <P>
          Le responsable du traitement est l&apos;organisateur de {eventInfo.name} :
          <strong> À COMPLÉTER (raison sociale, adresse postale)</strong>. Contact
          pour toute question relative à vos données :{" "}
          <a className="font-semibold text-cobalt" href="mailto:contact@bis-algeria.dz">
            contact@bis-algeria.dz
          </a>
          .
        </P>

        <H>2. Quelles données collectons-nous ?</H>
        <ul className="mt-3 list-disc pl-5">
          <Li>
            <strong>Compte</strong> : prénom, nom, adresse email, mot de passe
            (conservé uniquement sous forme chiffrée irréversible), date de
            confirmation de l&apos;email.
          </Li>
          <Li>
            <strong>Inscription</strong> : téléphone, pays, organisation, fonction,
            type de participation, choix de salles, et les informations que vous
            saisissez dans les formulaires (sponsor, partenaire, intervenant,
            créateur de contenu).
          </Li>
          <Li>
            <strong>Badge</strong> : un QR code personnel (identifiant aléatoire,
            sans donnée personnelle encodée) et un code de secours imprimé sur le
            badge.
          </Li>
          <Li>
            <strong>Contrôle d&apos;accès</strong> : date, lieu (porte / salle) et
            résultat de chaque passage du badge pendant l&apos;événement.
          </Li>
          <Li>
            <strong>Messages</strong> : les emails que nous vous envoyons
            (confirmation, informations pratiques) et votre historique d&apos;envoi.
          </Li>
          <Li>
            <strong>Sécurité</strong> : adresse IP (tronquée lorsqu&apos;elle est conservée) et journaux techniques
            servant à limiter les abus ; journal d&apos;audit des actions
            d&apos;administration.
          </Li>
        </ul>
        <P>
          Nous ne collectons <strong>aucune donnée de paiement</strong> (l&apos;événement
          est gratuit), <strong>aucune géolocalisation</strong>, et nous n&apos;utilisons
          <strong> aucun traceur publicitaire</strong>.
        </P>

        <H>3. Pourquoi (finalités) ?</H>
        <ul className="mt-3 list-disc pl-5">
          <Li>Créer et sécuriser votre compte, vous inscrire et vous délivrer votre badge.</Li>
          <Li>Contrôler l&apos;accès aux portes et salles de l&apos;événement.</Li>
          <Li>Vous écrire pour l&apos;organisation de l&apos;événement.</Li>
          <Li>Prévenir la fraude et les abus, et tenir un journal de sécurité.</Li>
        </ul>

        <H>4. Fonctionnement hors ligne de l&apos;application</H>
        <P>
          Si vous le souhaitez (option activée par défaut, désactivable dans
          « Mon badge »), l&apos;application garde sur votre appareil une copie de
          votre badge et de votre profil : prénom, nom, fonction, organisation,
          rôle, email, téléphone, pays, type de participation, statut
          d&apos;inscription, image du QR code et code de secours. Cette copie est stockée localement sur l&apos;appareil (stockage de
          l&apos;application ou du navigateur, plus un petit service worker qui ne
          garde que des fichiers publics), n&apos;est jamais envoyée à un tiers,
          est supprimée dès que le site ou l&apos;application est rouvert sans
          session ou avec un autre compte, à la suppression du compte ou de
          l&apos;application, et expire automatiquement après 14 jours. Si vous
          n&apos;ouvrez pas l&apos;application, la copie reste sur l&apos;appareil
          jusqu&apos;à ce délai. L&apos;espace d&apos;administration ne
          fonctionne qu&apos;avec une connexion Internet et rien de
          l&apos;administration n&apos;est conservé hors ligne.
        </P>

        <H>5. Caméra</H>
        <P>
          La caméra n&apos;est utilisée que par l&apos;équipe de l&apos;événement,
          dans l&apos;espace d&apos;administration, pour scanner les badges. Les
          images ne sont ni enregistrées ni transmises.
        </P>

        <H>6. Avec qui partageons-nous ?</H>
        <P>
          Vos données ne sont ni vendues ni louées. Elles sont accessibles à
          l&apos;équipe habilitée de l&apos;organisateur (selon des rôles
          limités) et à nos prestataires techniques strictement nécessaires :
          hébergement et base de données, envoi d&apos;emails.{" "}
          <strong>À COMPLÉTER</strong> : nom et pays de l&apos;hébergeur et du
          prestataire d&apos;emailing.
        </P>

        <H>7. Combien de temps ?</H>
        <P>
          Les données de compte et d&apos;inscription sont conservées jusqu&apos;à
          la suppression de votre compte, puis au plus{" "}
          <strong>À COMPLÉTER (durée)</strong> après l&apos;événement pour les
          obligations légales. Les sauvegardes chiffrées sont renouvelées
          régulièrement et les anciennes sont supprimées selon une politique de
          rétention fixe.
        </P>

        <H>8. Vos droits</H>
        <P>
          Vous pouvez accéder à vos données, les corriger, vous opposer à leur
          traitement ou les faire supprimer. La suppression est possible{" "}
          <strong>directement dans l&apos;application et sur le site</strong> :
          <em> Mon compte → Sécurité → Supprimer mon compte</em>. Votre
          inscription et votre badge sont alors supprimés ; vos demandes sont
          anonymisées ; l&apos;historique de passage est conservé sous forme anonyme (porte,
          heure, résultat, sans identité ni code). Les sauvegardes et le journal
          d&apos;audit de sécurité peuvent conserver des identifiants techniques
          jusqu&apos;à leur expiration. Pour toute autre demande, écrivez-nous (voir §1) ou utilisez la
          page{" "}
          <Link className="font-semibold text-cobalt" href="/contact">
            Contact
          </Link>
          . Vous pouvez aussi saisir l&apos;autorité de protection des données
          compétente.
        </P>

        <H>9. Sécurité</H>
        <P>
          Connexions chiffrées (HTTPS), mots de passe hachés, QR code aléatoire
          révocable (seule l&apos;administration autorisée peut le remplacer),
          rôles d&apos;administration à droits minimaux, journal d&apos;audit,
          limitation des tentatives et sauvegardes chiffrées.
        </P>

        <H>10. Enfants</H>
        <P>
          Le service s&apos;adresse à un public professionnel et n&apos;est pas
          destiné aux enfants.
        </P>

        <H>11. Modifications</H>
        <P>
          Nous pouvons mettre à jour cette politique ; la date en tête de page
          indique la dernière version.
        </P>
      </div>
    </section>
  );
}
