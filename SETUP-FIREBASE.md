# Configurar sincronização na nuvem (Firebase)

Siga estes passos **uma vez** para que celular e computador compartilhem o mesmo histórico.

## 1. Criar projeto Firebase (grátis)

1. Acesse [https://console.firebase.google.com](https://console.firebase.google.com)
2. **Adicionar projeto** → nome ex.: `controle-carro` → continue (Analytics opcional)
3. No projeto: **Criar app** → ícone **Web** `</>`
4. Registre o app e copie o objeto `firebaseConfig`

## 2. Ativar Firestore

1. Menu **Firestore Database** → **Criar banco de dados**
2. Modo **produção** → região mais próxima (ex. `southamerica-east1`)
3. Aba **Regras** → cole e publique:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cars/{syncId} {
      allow read, write: if true;
    }
  }
}
```

> Uso pessoal: quem souber seu código `XXXX-XXXX-XXXX` acessa os dados. Guarde o código em local seguro.

## 3. Configurar o app

1. Copie `firebase-config.example.js` para `firebase-config.js`
2. Cole suas chaves do Firebase em `window.FIREBASE_CONFIG`
3. Envie para o GitHub:

```bash
git add firebase-config.js
git commit -m "Ativar sincronização Firebase"
git push
```

Em ~1 minuto o site atualiza: https://bbvcunha.github.io/SERREV/

## 4. Usar em vários aparelhos

1. No **celular**: abra o app → aba **Conta** → **Copiar** o código
2. No **outro aparelho**: aba **Conta** → cole o código → **Conectar**

Pronto: abastecimentos e alarmes sincronizam automaticamente.

## Sem Firebase

Use **Exportar backup** num aparelho e **Importar backup** no outro (arquivo JSON).
