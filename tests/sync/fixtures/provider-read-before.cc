    const auto& success = *response->value().success;
    if (!success.data || !success.revision || success.revision->empty() ||
        success.data->size() > maximum)
      return base::unexpected(Error::kInvalidData);
    return syncer::OpaqueSyncVaultObject{*success.data, *success.revision};
