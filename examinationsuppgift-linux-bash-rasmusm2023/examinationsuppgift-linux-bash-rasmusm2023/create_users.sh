#!/bin/bash
#
# Skapar Linux-användare med hemkatalog, standardundermappar och välkomstfil.
# Anrop: sudo ./create_users.sh <namn1> [namn2 ...]
#

# Endast root får hantera konton och filsystem i andras hemkataloger.
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
	echo "Fel: kör skriptet som root (exempelvis med sudo)." >&2
	exit 1
fi

if [ "$#" -lt 1 ]; then
	echo "Användning: $0 <användarnamn> [fler namn ...]" >&2
	exit 1
fi

# Steg 1: lägg upp alla konton så att de syns i systemet innan välkomstfiler skrivs.
for anvandare in "$@"; do
	if id "$anvandare" &>/dev/null; then
		echo "Varning: $anvandare finns redan, hoppar över useradd." >&2
	else
		# -m skapar hemkatalog enligt systemets standard.
		useradd -m "$anvandare" || exit 1
	fi
done

# Steg 2: kataloger, rättigheter och välkomsttext för varje användare.
for anvandare in "$@"; do
	# Hämta hemsökväg även om kontot fanns sedan tidigare.
	hem=$(getent passwd "$anvandare" | cut -d: -f6)
	if [ -z "$hem" ] || [ ! -d "$hem" ]; then
		echo "Fel: ingen hemkatalog för $anvandare." >&2
		exit 1
	fi

	# Obligatoriska undermappar.
	mkdir -p "$hem/Documents" "$hem/Downloads" "$hem/Work"
	# 700: bara ägaren läser, skriver och listar innehåll.
	chmod 700 "$hem/Documents" "$hem/Downloads" "$hem/Work"
	chown "$anvandare:$anvandare" "$hem/Documents" "$hem/Downloads" "$hem/Work"

	# Första raden personlig; därefter övriga användarnamn i /etc/passwd.
	{
		echo "Välkommen $anvandare"
		awk -F: -v undantag="$anvandare" '$1 != undantag { print $1 }' /etc/passwd
	} >"$hem/welcome.txt"

	chown "$anvandare:$anvandare" "$hem/welcome.txt"
	# Läsbar välkomstfil för ägaren; inget krav på att andra ska läsa den.
	chmod 644 "$hem/welcome.txt"
done

exit 0
